// The Countersign agent: invoice in -> read -> screen -> (investigate) -> verdict ->
// pay or hold-and-text -> approver replies -> pay or block. Every step is traced.
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEmail, CaseFile } from './forensics.js';
import { extract, explain } from './llm.js';
import { resolveVendor, screen, plan, tools, score } from './checks.js';
import { nextSeq } from './store.js';
import { bankKey, maskAcct, money, toBank } from './text.js';
import { pdfText } from './pdf.js';
import { cfg } from './config.js';

export class Agent {
  constructor({ store, series, bank, ledger, notifier, emit = () => {}, stepDelayMs = 0 }) {
    Object.assign(this, { store, series, bank, ledger, notifier, emit, stepDelayMs });
    notifier.onReply = (text, actor) => this.handleReply(text, actor);
  }

  async #blocklist() { return (await this.store.col('meta').get('blocklist'))?.keys || []; }
  async #save(req) { await this.store.col('cases').put(req); this.emit('request', { id: req.id }); }
  async #step(req, step, detail, tool) {
    req.trace.push({ ts: new Date().toISOString(), step, tool: tool || null, detail });
    await this.#save(req);
    if (this.stepDelayMs) await sleep(this.stepDelayMs);
  }

  // input: { raw } for an email, or { pdf: Buffer, filename, sender } for an uploaded invoice.
  async process(input) {
    const pdf = input.pdf || null;
    let raw = typeof input === 'string' ? input : input.raw;
    if (pdf) raw = `From: ${input.sender ? `<${input.sender}>` : ''}\nSubject: ${input.filename || 'invoice.pdf'}\n\n${await pdfText(pdf)}`;
    const n = await nextSeq(this.store, 'requestSeq', 1040);
    const req = {
      id: `PR-${n}`, n, receivedAt: new Date().toISOString(), raw, status: 'analysing',
      source: pdf ? { kind: 'pdf', filename: input.filename || 'invoice.pdf' } : { kind: 'email' },
      extracted: null, vendorId: null, vendorName: null, verdict: null, caseFile: null,
      trace: [], payment: null, decision: null, billId: null,
    };
    const cf = new CaseFile();

    // 1. Read
    const email = parseEmail(raw);
    req.email = { from: email.from, subject: email.subject, replyTo: email.replyTo, auth: email.auth };
    await this.#step(req, 'intake', pdf ? `PDF "${req.source.filename}"${email.from ? ` from ${email.from}` : ''}` : `Email from ${email.from}: "${email.subject}"`);
    const read = await extract(email, pdf);
    // Privacy: keep a fingerprint and the last four digits, never the account number itself.
    if (read.bank.account) req.raw = raw.split(read.bank.account).join(`[account ending ${String(read.bank.account).slice(-4)}]`);
    req.extracted = { ...read, bank: toBank(read.bank.routing, read.bank.account, read.bank.bankName) };
    const x = req.extracted;
    await this.#step(req, 'read', `${x.extractor === 'gemini' ? 'Gemini' : 'Rule-based reader'} extracted ${x.invoiceNumber || 'no invoice #'}, ${money(x.amount || 0)}, account ${maskAcct(x.bank)}`, 'extract_invoice');

    // 2. Match to the vendor master
    const vendors = await this.store.col('vendors').all();
    const hits = await this.store.searchVendors(x.vendorName || email.fromName || '');
    const resolution = resolveVendor(vendors, email, x, hits);
    const vendor = resolution.vendor;
    req.vendorId = vendor?.id || null;
    req.vendorName = vendor?.name || x.vendorName || email.fromName;
    await this.#step(req, 'match', vendor ? `Matched to ${vendor.name} by ${resolution.how}` : 'No approved vendor matches this sender', 'vendor_lookup');

    // 3. Screen
    const baseline = vendor ? await this.series.baseline(vendor.id) : { n: 0, rows: [], monthly: [] };
    const paid = await this.series.paid();
    const data = { req, email, vendor, resolution, vendors, baseline, blocklist: await this.#blocklist(), paid, cf };
    const findings = screen(data);
    cf.event(req.receivedAt, pdf ? 'upload' : 'email-header', `Invoice ${x.invoiceNumber || ''} received${email.from ? ` from ${email.from}` : ' by upload'}`, { suspicious: findings.length > 0 });
    await this.#step(req, 'screen', findings.length ? `${findings.length} check(s) raised: ${findings.map((f) => f.code).join(', ')}` : 'All screening checks passed', 'screen');

    // 4. Investigate only what screening raised
    const todo = plan(findings);
    if (todo.length) {
      await this.#step(req, 'plan', `Investigating with: ${todo.join(' → ')}`);
      data.signins = vendor ? (await this.store.col('signins').all()).filter((s) => s.vendorId === vendor.id) : [];
      data.bankChanges = vendor ? (await this.store.col('bankChanges').all()).filter((c) => c.vendorId === vendor.id) : [];
      data.allSignins = (await this.store.col('signins').all()).sort((a, b) => a.ts.localeCompare(b.ts));
      data.otherCases = (await this.store.col('cases').all()).filter((c) => c.id !== req.id && c.indicators);
      data.findings = findings;
      for (const name of todo) {
        const r = tools[name](data);
        findings.push(...r.findings);
        await this.#step(req, 'investigate', r.note + (r.findings.length ? ` — ${r.findings.map((f) => f.code).join(', ')}` : ''), name);
      }
      req.caseFile = cf.toJSON();
    }

    // 5. Verdict
    findings.sort((a, b) => b.points - a.points);
    req.verdict = { ...score(findings), findings };
    const said = await explain(req);
    req.verdict.summary = said.text;
    req.verdict.explainedBy = said.by;
    await this.#step(req, 'verdict', `${req.verdict.decision.toUpperCase()} · risk ${req.verdict.risk}/100`);

    // 6. Act
    try { req.billId = (await this.bank.createBill(req)).billId; } catch (err) { console.warn('[bank] bill:', err.message); }
    await this.ledger.append({ requestId: req.id, action: req.verdict.decision, actor: 'countersign-agent', risk: req.verdict.risk, summary: `${req.vendorName} ${money(x.amount || 0)} -> ${maskAcct(x.bank)}` });
    if (req.verdict.decision === 'clear') {
      req.status = 'cleared';
      await this.#pay(req, vendor);
      await this.#step(req, 'act', req.status === 'paid' ? `Paid ${money(x.amount)} (${req.payment.rail})` : `Payment failed: ${req.payment?.error}`, 'bank_pay');
    } else {
      req.status = 'held';
      await this.#event(req, vendor, 'held');
      await this.notifier.send(this.#holdText(req, vendor), { requestId: req.id });
      await this.#step(req, 'act', `Payment held. Texted ${cfg.approverName}`, 'text_approver');
    }
    return req;
  }

  #holdText(req, vendor) {
    const top = req.verdict.findings.slice(0, 3).map((f) => `• ${f.title}`).join('\n');
    const call = vendor?.phone ? `\nVerify by calling ${vendor.name} on the number on file, ${vendor.phone}. Do not use a number from the invoice.` : '';
    return `Countersign HOLD · ${req.id}\n${req.vendorName} · ${money(req.extracted.amount || 0)}\nRisk ${req.verdict.risk}/100\n${top}${call}\nReply APPROVE ${req.n}, HOLD ${req.n} or WHY ${req.n}.`;
  }

  // One row per payment event in the time series: paid | held | declined.
  async #event(req, vendor, status, txnId = null) {
    if (!vendor || !req.extracted.amount) return;
    await this.series.record({
      ts: new Date().toISOString(), vendorId: vendor.id, amount: req.extracted.amount, status, txnId,
      invoiceNumber: req.extracted.invoiceNumber, requestId: req.id, bankKey: bankKey(req.extracted.bank), bankLast4: req.extracted.bank.last4,
    }).catch((err) => console.warn('[series]', err.message));
  }

  async #pay(req, vendor) {
    try {
      const r = await this.bank.pay(req, vendor);
      req.payment = { ...r, ts: new Date().toISOString(), amount: req.extracted.amount, toAccount: maskAcct(req.extracted.bank) };
      req.status = 'paid';
      await this.bank.closeBill(req.billId, 'completed').catch(() => {});
      await this.#event(req, vendor, 'paid', r.ref);
    } catch (err) {
      req.payment = { error: err.message };
      req.status = 'pay_failed';
    }
    await this.#save(req);
  }

  // Background worker: a hold nobody has answered gets one reminder, so it cannot sit unseen.
  async remindStale(afterMs) {
    const stale = (await this.store.col('cases').all())
      .filter((r) => r.status === 'held' && !r.remindedAt && Date.now() - Date.parse(r.receivedAt) >= afterMs)
      .sort((a, b) => a.n - b.n);
    for (const r of stale) {
      const mins = Math.round((Date.now() - Date.parse(r.receivedAt)) / 60000);
      await this.notifier.send(`Reminder · ${r.id} is still on hold after ${mins} min\n${r.vendorName} · ${money(r.extracted.amount || 0)} · risk ${r.verdict.risk}/100\nReply APPROVE ${r.n}, HOLD ${r.n} or WHY ${r.n}.`, { requestId: r.id });
      r.remindedAt = new Date().toISOString();
      r.trace.push({ ts: r.remindedAt, step: 'worker', tool: 'text_approver', detail: `No reply after ${mins} min. Reminder sent` });
      await this.#save(r);
    }
    return stale.length;
  }
  startWorker(afterMs, everyMs = 60000) {
    setInterval(() => this.remindStale(afterMs).catch((err) => console.warn('[worker]', err.message)), everyMs).unref();
  }

  // The approver's decision on a held request: 'approve' releases it, 'hold' blocks it for good.
  async decide(id, action, actor = cfg.approverName) {
    const req = await this.store.col('cases').get(id);
    if (!req) throw new Error(`No request ${id}`);
    if (req.status !== 'held') throw new Error(`${id} is ${req.status}, not awaiting a decision`);
    const vendor = req.vendorId ? await this.store.col('vendors').get(req.vendorId) : null;
    req.decision = { action, actor, ts: new Date().toISOString() };
    const key = bankKey(req.extracted.bank);

    if (action === 'approve') {
      if (!vendor) throw new Error(`${id}: sender is not an approved vendor. Onboard the vendor first; it cannot be approved by text.`);
      // The approver vouches for the new details (after the phone call), so they become the vendor master.
      if (key && key !== bankKey(vendor.bank)) {
        vendor.bankHistory = [...(vendor.bankHistory || []), { ...vendor.bank, retiredAt: req.decision.ts }];
        vendor.bank = { ...req.extracted.bank, verifiedAt: req.decision.ts, verifiedBy: actor };
        vendor.payeeAccountId = await this.bank.newPayee(vendor);
        await this.store.col('vendors').put(vendor);
        await this.ledger.append({ requestId: req.id, action: 'bank-master-updated', actor, risk: req.verdict.risk, summary: `${vendor.name} -> ${maskAcct(vendor.bank)}` });
      }
      req.status = 'approved';
      await this.ledger.append({ requestId: req.id, action: 'approve', actor, risk: req.verdict.risk, summary: `${req.vendorName} ${money(req.extracted.amount || 0)}` });
      await this.#pay(req, vendor);
      await this.#step(req, 'decision', `${actor} approved. ${req.status === 'paid' ? `Paid ${money(req.extracted.amount)}` : `Payment failed: ${req.payment?.error}`}`, 'bank_pay');
    } else {
      req.status = 'blocked';
      if (key) {
        const keys = await this.#blocklist();
        if (!keys.includes(key)) await this.store.col('meta').put({ id: 'blocklist', keys: [...keys, key] });
      }
      await this.bank.closeBill(req.billId, 'cancelled').catch(() => {});
      await this.#event(req, vendor, 'declined');
      await this.ledger.append({ requestId: req.id, action: 'block', actor, risk: req.verdict.risk, summary: `${req.vendorName} ${money(req.extracted.amount || 0)} · account ${maskAcct(req.extracted.bank)} blocklisted` });
      await this.#step(req, 'decision', `${actor} kept the hold. Payment blocked; account ${maskAcct(req.extracted.bank)} added to the blocklist`);
    }
    return req;
  }

  // Text replies: APPROVE 1042 · HOLD 1042 · WHY 1042 · STATUS (number optional when one item is waiting).
  async handleReply(text, actor) {
    const all = (await this.store.col('cases').all()).sort((a, b) => a.n - b.n);
    const held = all.filter((r) => r.status === 'held');
    const t = text.trim().toLowerCase();
    const n = Number(t.match(/(\d{3,})/)?.[1]) || null;
    const verb = /^(approve|yes|pay|release|ok)\b/.test(t) ? 'approve'
      : /^(hold|no|block|reject|stop|deny)\b/.test(t) ? 'hold'
      : /^(why|explain|details?)\b/.test(t) ? 'why'
      : /^(status|list|queue|hi|hello|start)\b/.test(t) ? 'status' : null;

    if (!verb) return 'I can take: APPROVE <number>, HOLD <number>, WHY <number>, or STATUS.';
    if (verb === 'status') {
      if (!held.length) return `Nothing is waiting on you. ${all.filter((r) => r.status === 'paid').length} payment(s) cleared.`;
      return `${held.length} payment(s) on hold:\n${held.map((r) => `${r.n} · ${r.vendorName} · ${money(r.extracted.amount || 0)} · risk ${r.verdict.risk}`).join('\n')}\nReply APPROVE, HOLD or WHY with the number.`;
    }
    const target = n ? all.find((r) => r.n === n) : held.length === 1 ? held[0] : null;
    if (!target) return n ? `I have no request ${n}.` : held.length ? `${held.length} are waiting. Which one? ${held.map((r) => r.n).join(', ')}` : 'Nothing is on hold right now.';
    if (verb === 'why') {
      return `${target.id} · ${target.vendorName}\n${target.verdict.findings.slice(0, 4).map((f) => `• ${f.title}: ${f.detail}`).join('\n') || 'No checks were raised.'}`;
    }
    if (target.status !== 'held') return `${target.id} is already ${target.status}.`;
    try {
      const r = await this.decide(target.id, verb, actor);
      if (verb === 'hold') return `${r.id} blocked. Nothing was paid, and account ${maskAcct(r.extracted.bank)} is now blocklisted for every vendor.`;
      return r.status === 'paid'
        ? `${r.id} released: ${money(r.extracted.amount)} paid to ${r.vendorName}, account ${maskAcct(r.extracted.bank)}. Logged as approved by you.`
        : `${r.id} approved, but the bank rejected the payment: ${r.payment?.error}`;
    } catch (err) {
      return err.message;
    }
  }
}
