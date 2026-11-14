// The checks that decide. Deterministic on purpose: the same invoice always gets the
// same score, and nothing written inside an invoice can change it.
//   screen()      runs on every payment request
//   investigate() runs only when screen() raised something, using tools picked for what it raised
import { isLookalikeDomain, similarity, normName, bankKey, maskAcct, money } from './text.js';
import { analyseSignins } from './forensics.js';

const DAY = 86400000;
export const HOLD_AT = 40;

const f = (code, points, title, detail, evidence = [], critical = false) => ({ code, points, title, detail, evidence, critical });

// Who is this invoice claiming to be from?
export function resolveVendor(vendors, email, extracted, hits = []) {
  const byDomain = vendors.find((v) => v.domain === email.fromDomain);
  if (byDomain) return { vendor: byDomain, how: 'sender domain' };
  const name = extracted.vendorName || email.fromName;
  const exact = vendors.find((v) => normName(v.name) === normName(name));
  if (exact) return { vendor: exact, how: 'vendor name' };
  const byLookDomain = vendors.find((v) => isLookalikeDomain(email.fromDomain, v.domain));
  const best = hits[0] || vendors.map((v) => ({ vendor: v, score: similarity(name, v.name) })).sort((a, b) => b.score - a.score)[0];
  if (best && best.score >= 0.8) return { vendor: best.vendor, how: 'look-alike name', lookalike: { score: best.score, claimed: name } };
  if (byLookDomain) return { vendor: byLookDomain, how: 'look-alike domain' };
  return { vendor: null, how: 'no match' };
}

export function screen({ req, email, vendor, resolution, vendors, baseline, blocklist, paid, cf }) {
  const out = [];
  const x = req.extracted;
  const key = bankKey(x.bank);

  // --- who sent it
  if (!vendor) {
    const e = cf.add('vendor-master', 'Vendor lookup', `No vendor matches "${x.vendorName || email.fromName}" or domain ${email.fromDomain}`);
    out.push(f('UNKNOWN_VENDOR', 40, 'Sender is not in the vendor master', 'No approved vendor matches this name or domain. New payees need onboarding before a first payment.', [e], true));
  } else {
    if (resolution.lookalike) {
      const e = cf.add('vendor-master', 'Look-alike vendor search', `Invoice names "${resolution.lookalike.claimed}"; closest approved vendor is "${vendor.name}" (${Math.round(resolution.lookalike.score * 100)}% match)`);
      out.push(f('NAME_LOOKALIKE', 30, 'Vendor name is a near-copy of an approved vendor', `"${resolution.lookalike.claimed}" is not on file, but it is one or two characters away from "${vendor.name}".`, [e]));
    }
    if (email.fromDomain && email.fromDomain !== vendor.domain) {
      const look = isLookalikeDomain(email.fromDomain, vendor.domain);
      const e = cf.add('email-header', 'From', `From: ${email.from} — vendor on file uses @${vendor.domain}`);
      out.push(look
        ? f('DOMAIN_LOOKALIKE', 30, 'Sender domain imitates the vendor\'s domain', `${email.fromDomain} is not ${vendor.domain}. It differs by a character or two, which is how impersonation domains are registered.`, [e])
        : f('DOMAIN_MISMATCH', 20, 'Sender domain is not the vendor\'s domain', `Mail came from ${email.fromDomain}; ${vendor.name} has only ever written from ${vendor.domain}.`, [e]));
    }
  }
  const { spf, dkim, dmarc } = email.auth;
  if ([spf, dmarc].includes('fail') || dkim === 'fail') {
    const e = cf.add('email-header', 'Authentication-Results', email.auth.raw);
    out.push(f('AUTH_FAIL', 20, 'Email failed sender authentication', `SPF ${spf}, DKIM ${dkim}, DMARC ${dmarc}. The sending server is not authorised to send for this domain.`, [e]));
  }
  if (email.replyTo && email.replyToDomain !== email.fromDomain) {
    const e = cf.add('email-header', 'Reply-To', `Reply-To: ${email.replyTo} (From: ${email.from})`);
    out.push(f('REPLY_TO_MISMATCH', 15, 'Replies are redirected to a different address', `Answers would go to ${email.replyTo}, not to the address the email appears to come from.`, [e]));
  }
  const origin = email.received.at(-1);
  if (vendor && origin?.ip && vendor.senderIps?.length && !vendor.senderIps.includes(origin.ip)) {
    const e = cf.add('email-header', 'Received (origin hop)', origin.raw);
    out.push(f('NEW_ORIGIN', 10, 'Sent from a mail server this vendor has never used', `Origin ${origin.host} (${origin.ip}); earlier mail from ${vendor.name} came from ${vendor.senderIps.join(', ')}.`, [e]));
  }

  // --- where the money would go
  if (key && blocklist.includes(key)) {
    const e = cf.add('blocklist', 'Blocked account', `Account ${maskAcct(x.bank)} (routing ${x.bank.routing}) was blocked by an approver on an earlier request`);
    out.push(f('BANK_BLOCKLISTED', 60, 'Bank account was blocked on an earlier fraud attempt', 'An approver already refused a payment to this exact account.', [e], true));
  }
  if (vendor && key && key !== bankKey(vendor.bank)) {
    const e = cf.add('vendor-master', 'Bank details on file', `On file for ${vendor.name}: routing ${vendor.bank.routing}, account ${maskAcct(vendor.bank)} (verified ${vendor.bank.verifiedAt?.slice(0, 10)}). Invoice asks for routing ${x.bank.routing}, account ${maskAcct(x.bank)}.`);
    out.push(f('BANK_CHANGE', 35, 'Bank details differ from the vendor master', `Payment would go to ${maskAcct(x.bank)}, not the verified account ${maskAcct(vendor.bank)}. Policy: every bank change is confirmed by phone before any payment.`, [e], true));
    const other = vendors.find((v) => v.id !== vendor.id && bankKey(v.bank) === key);
    if (other) out.push(f('BANK_SHARED', 30, 'Account belongs to a different vendor', `The same account is on file for ${other.name}.`, [e]));
  }

  // --- does it fit this vendor's history
  if (vendor && baseline.n >= 4 && x.amount) {
    const z = (x.amount - baseline.mean) / baseline.spread;
    if (z >= 3) {
      const e = cf.add('payment-history', 'Amount baseline', `${baseline.n} past payments to ${vendor.name}: mean ${money(baseline.mean)}, sd ${money(baseline.sd)}. This invoice: ${money(x.amount)} (z = ${z.toFixed(1)})`);
      out.push(f('AMOUNT_ANOMALY', z >= 6 ? 40 : 25, 'Amount is far above this vendor\'s normal range', `${money(x.amount)} is ${(x.amount / baseline.mean).toFixed(1)}× the average of ${money(baseline.mean)}.`, [e]));
    }
    if (baseline.medianGapDays && baseline.lastTs) {
      const gap = (Date.parse(req.receivedAt) - Date.parse(baseline.lastTs)) / DAY;
      if (gap < baseline.medianGapDays * 0.5) {
        const e = cf.add('payment-history', 'Billing cadence', `Last payment ${gap.toFixed(0)} days ago; this vendor normally bills every ${baseline.medianGapDays.toFixed(0)} days`);
        out.push(f('OFF_CADENCE', 10, 'Invoice arrived off the usual billing cycle', `Only ${gap.toFixed(0)} days since the last payment; the normal gap is ${baseline.medianGapDays.toFixed(0)} days.`, [e]));
      }
    }
  }
  const dup = vendor && x.invoiceNumber && paid.find((p) => p.vendorId === vendor.id && p.invoiceNumber === x.invoiceNumber);
  if (dup) {
    const e = cf.add('payment-history', 'Earlier payment', `${x.invoiceNumber} was paid on ${dup.ts.slice(0, 10)} for ${money(dup.amount)}`);
    out.push(f('DUPLICATE_INVOICE', 45, 'This invoice number was already paid', `${x.invoiceNumber} was settled on ${dup.ts.slice(0, 10)}. Paying again would be a double payment.`, [e], true));
  }

  // --- how it is written
  if (x.urgency) {
    const line = email.body.split('\n').find((l) => /(urgent|immediately|today|asap|24 hours|late fee|final notice|do not call)/i.test(l)) || '';
    const e = cf.add('email-body', 'Pressure language', line.trim().slice(0, 200));
    out.push(f('URGENCY', 10, 'Pressure to pay fast or skip verification', 'The message pushes for immediate payment, a common social-engineering tactic.', [e]));
  }
  const inj = email.body.split('\n').find((l) => /(ai|assistant|automated|system|agent)s?\b.{0,60}(ignore|approve|pre-?approved|skip|bypass|mark)/i.test(l));
  if (inj) {
    const e = cf.add('email-body', 'Embedded instruction', inj.trim().slice(0, 200));
    out.push(f('PROMPT_INJECTION', 25, 'Invoice contains instructions aimed at automated reviewers', 'Text in the invoice tries to tell an AI system to approve it. Countersign treats invoice text as data, never as instructions.', [e]));
  }
  return out;
}

// Chooses investigation tools from what screening raised.
export function plan(findings) {
  const has = (...codes) => findings.some((x) => codes.includes(x.code));
  const tools = [];
  if (has('BANK_CHANGE', 'BANK_BLOCKLISTED', 'BANK_SHARED')) tools.push('bank_change_timeline', 'portal_signin_logs');
  if (has('AUTH_FAIL', 'DOMAIN_LOOKALIKE', 'DOMAIN_MISMATCH', 'REPLY_TO_MISMATCH', 'NEW_ORIGIN')) tools.push('email_route');
  if (findings.length) tools.push('payment_history', 'cross_case_links');
  return tools;
}

export const tools = {
  bank_change_timeline({ vendor, bankChanges, req, cf }) {
    if (!vendor) return { note: 'no vendor on file', findings: [] };
    cf.event(vendor.bank.verifiedAt, 'bank-change', `Bank details verified by phone: account ${maskAcct(vendor.bank)}`);
    const out = [];
    const key = bankKey(req.extracted.bank);
    for (const c of bankChanges) {
      const matches = bankKey(c.bank) === key;
      const e = cf.add('bank-change', `Change request ${c.id}`, `${c.ts} · via ${c.via} · new account ${maskAcct(c.bank)} · status ${c.status}${c.sessionId ? ` · session ${c.sessionId}` : ''}`);
      cf.event(c.ts, 'bank-change', `Bank-detail change requested via ${c.via}: account ${maskAcct(c.bank)} (${c.status})`, { suspicious: matches, evidence: [e] });
      if (matches) {
        const days = ((Date.parse(req.receivedAt) - Date.parse(c.ts)) / DAY).toFixed(0);
        out.push(f('CHANGE_THEN_INVOICE', 15, 'Invoice follows an unverified bank-change request', `The new account was submitted through the ${c.via} ${days} day(s) before this invoice and was never confirmed by phone.`, [e]));
      }
    }
    return { note: `${bankChanges.length} change request(s) on record`, findings: out };
  },

  portal_signin_logs(data) {
    const { vendor, signins, bankChanges, req, cf } = data;
    if (!vendor || !signins.length) return { note: 'no portal sign-ins on record', findings: [] };
    const { anomalies, knownCountries, historyCount } = analyseSignins(signins, bankChanges, Date.parse(req.receivedAt));
    for (const s of signins.filter((x) => !x.ok).slice(-6)) cf.event(s.ts, 'signin-log', `Failed portal sign-in from ${s.ip} (${s.country})`, { suspicious: true });
    const out = [];
    data.signinAnomalies = anomalies;
    for (const a of anomalies) {
      const s = a.signin;
      const e = cf.add('signin-log', `Portal session ${s.sessionId}`, `${s.ts} · ${s.user} · ${s.ip} (${s.country}, ${s.network}) · ${s.device} · ${a.reasons.join('; ')}`);
      cf.event(s.ts, 'signin-log', `Portal sign-in from ${s.ip} (${s.country}): ${a.reasons.join('; ')}`, { suspicious: true, evidence: [e] });
      out.push(f('SIGNIN_ANOMALY', a.change ? 30 : 15,
        a.change ? 'Bank change was made from a session that looks like an account takeover' : 'Unusual sign-in to the vendor\'s portal account',
        `${a.reasons.join('; ')}. ${historyCount} earlier sign-ins all came from ${knownCountries.join(', ') || 'elsewhere'}.${a.change ? ` The bank-detail change ${a.change.id} was made in this session.` : ''}`, [e]));
    }
    return { note: `${signins.length} sign-ins analysed, ${anomalies.length} anomalous`, findings: out };
  },

  email_route({ email, req, cf }) {
    const hops = [...email.received].reverse();
    hops.forEach((h, i) => {
      const e = cf.add('email-header', `Received hop ${i + 1}`, h.raw);
      cf.event(new Date(Date.parse(req.receivedAt) - (hops.length - i) * 2000).toISOString(), 'email-header', `Mail relayed by ${h.host}${h.ip ? ` (${h.ip})` : ''}`, { suspicious: i === 0, evidence: [e] });
    });
    return { note: `${hops.length} relay hop(s) reconstructed`, findings: [] };
  },

  payment_history({ vendor, baseline, cf }) {
    if (!vendor) return { note: 'no history', findings: [] };
    for (const p of baseline.rows.slice(-3)) cf.event(p.ts, 'payment-history', `Paid ${p.invoiceNumber} · ${money(p.amount)} to account ${maskAcct({ last4: p.bankLast4 })}`);
    return { note: `${baseline.n} past payments, mean ${money(baseline.mean)}`, findings: [] };
  },
};

// Links this case to other activity through shared infrastructure: an IP or a bank
// account that also shows up for a different vendor or in an earlier case.
tools.cross_case_links = ({ req, email, vendor, findings, allSignins, otherCases, signinAnomalies = [], cf }) => {
  const has = (...codes) => findings.some((x) => codes.includes(x.code));
  const ips = new Set(signinAnomalies.map((a) => a.signin.ip));
  const origin = email.received.at(-1)?.ip;
  if (origin && has('NEW_ORIGIN', 'AUTH_FAIL', 'DOMAIN_LOOKALIKE', 'DOMAIN_MISMATCH', 'UNKNOWN_VENDOR')) ips.add(origin);
  const fp = has('BANK_CHANGE', 'BANK_BLOCKLISTED') ? bankKey(req.extracted.bank) : '';
  req.indicators = { ips: [...ips], fingerprint: fp };
  const out = [];
  for (const ip of ips) {
    const hits = allSignins.filter((s) => s.ip === ip && s.vendorId !== vendor?.id);
    if (hits.length) {
      const last = hits.at(-1);
      const e = cf.add('signin-log', `IP ${ip} in portal logs`, `${hits.length} portal sign-in attempt(s) on ${last.user} from ${ip} (${last.country}, ${last.network}), most recent ${last.ts}`);
      cf.event(last.ts, 'signin-log', `Same IP ${ip} signed in to another vendor's portal account (${last.user})`, { suspicious: true, evidence: [e] });
      out.push(f('LINKED_ACTIVITY', 15, 'Same IP address is tied to another vendor account', `${ip} sent this email and also made ${hits.length} sign-in attempt(s) on ${last.user}. One actor appears to be working more than one vendor.`, [e]));
    }
  }
  for (const c of otherCases) {
    const sharedIp = (c.indicators?.ips || []).find((ip) => ips.has(ip));
    const sharedFp = fp && c.indicators?.fingerprint === fp;
    if (!sharedIp && !sharedFp) continue;
    const what = sharedFp ? `bank account ${maskAcct(req.extracted.bank)}` : `IP ${sharedIp}`;
    const e = cf.add('case-link', `Earlier case ${c.id}`, `${c.id} (${c.vendorName}, ${c.status}) involved the same ${what}`);
    cf.event(c.receivedAt, 'case-link', `${c.id}: ${c.vendorName} request with the same ${what}`, { suspicious: true, evidence: [e] });
    out.push(f('LINKED_CASE', 15, `Shares ${sharedFp ? 'a bank account' : 'an IP address'} with an earlier case`, `${c.id} (${c.vendorName}) used the same ${what}.`, [e]));
  }
  return { note: `${ips.size} IP(s)${fp ? ' and 1 account' : ''} checked against other vendors and cases`, findings: out };
};

export function score(findings) {
  const risk = Math.min(100, findings.reduce((a, x) => a + x.points, 0));
  const decision = findings.some((x) => x.critical) || risk >= HOLD_AT ? 'hold' : 'clear';
  return { risk, decision };
}
