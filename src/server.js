import express from 'express';
import { fileURLToPath } from 'node:url';
import { cfg, integrations } from './config.js';
import { initStore } from './store.js';
import { initSeries } from './timeseries.js';
import { initBank } from './bank.js';
import { Ledger } from './ledger.js';
import { initNotifier } from './notify.js';
import { Agent } from './agent.js';
import { seed, SCENARIOS } from './seed.js';

const app = express();
// Keep the raw body: the Nessie webhook signature is computed over it.
app.use(express.json({ limit: '12mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

// Server-sent events keep the dashboard live while the agent works.
const clients = new Set();
const emit = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

const store = await initStore();
const series = await initSeries(store);
const bank = initBank(store);
const ledger = new Ledger(store, emit);
const notifier = initNotifier(store, emit);
const agent = new Agent({ store, series, bank, ledger, notifier, emit, stepDelayMs: Number(process.env.STEP_DELAY_MS ?? 450) });

if (!(await store.col('vendors').all()).length) {
  console.log('[seed] loading demo company, vendors and a year of payment history');
  await seed({ store, series, bank });
}
await notifier.start();
agent.startWorker(Number(process.env.REMIND_AFTER_MIN ?? 30) * 60000);

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(err); res.status(400).json({ error: err.message }); });
const cases = async () => (await store.col('cases').all()).sort((a, b) => b.n - a.n);
const summary = (r) => ({
  id: r.id, n: r.n, receivedAt: r.receivedAt, status: r.status, source: r.source?.kind, vendorId: r.vendorId, vendorName: r.vendorName,
  amount: r.extracted?.amount ?? null, invoiceNumber: r.extracted?.invoiceNumber ?? null,
  risk: r.verdict?.risk ?? null, verdict: r.verdict?.decision ?? null, top: r.verdict?.findings?.[0]?.title ?? null,
});
async function overview() {
  const all = await cases();
  const of = (st) => all.filter((r) => st.includes(r.status));
  const sum = (rows) => rows.reduce((a, r) => a + (r.extracted?.amount || 0), 0);
  return {
    balance: await bank.balance().catch(() => null),
    paid: sum(of(['paid'])), paidCount: of(['paid']).length,
    held: sum(of(['held'])), heldCount: of(['held']).length,
    blocked: sum(of(['blocked'])), blockedCount: of(['blocked']).length,
    byVerdict: { clear: all.filter((r) => r.verdict?.decision === 'clear').length, hold: all.filter((r) => r.verdict?.decision === 'hold').length },
  };
}

// ---- invoices and cases ----------------------------------------------------

// A new payment request: {pdfBase64, filename, sender}, {raw} email text, or a demo {scenario}.
// Add {wait: true} to get the finished case back instead of 202.
app.post('/api/invoices', wrap(async (req, res) => {
  const b = req.body;
  const input = b.pdfBase64 ? { pdf: Buffer.from(b.pdfBase64, 'base64'), filename: b.filename, sender: b.sender }
    : b.raw ? { raw: b.raw } : SCENARIOS[b.scenario]?.build();
  if (!input) return res.status(400).json({ error: 'send {pdfBase64}, {raw} or a known {scenario}' });
  const p = agent.process(input);
  if (b.wait) return res.status(201).json(await p);
  p.catch((err) => console.error('[agent]', err));
  res.status(202).json({ accepted: true });
}));

app.get('/api/cases', wrap(async (req, res) => {
  const all = await cases();
  res.json(all.filter((r) => !req.query.status || r.status === req.query.status).map(summary));
}));

app.get('/api/cases/:id', wrap(async (req, res) => {
  const r = await store.col('cases').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const vendor = r.vendorId ? await store.col('vendors').get(r.vendorId) : null;
  res.json({
    case: r, vendor, baseline: vendor ? await series.baseline(vendor.id) : null,
    ledger: (await ledger.entries()).filter((e) => e.requestId === r.id),
  });
}));

app.post('/api/cases/:id/decision', wrap(async (req, res) => {
  if (!['approve', 'hold'].includes(req.body.action)) return res.status(400).json({ error: 'action must be approve or hold' });
  res.json(summary(await agent.decide(req.params.id, req.body.action, `${cfg.approverName} via dashboard`)));
}));

// ---- vendors and metrics ---------------------------------------------------

app.get('/api/vendors', wrap(async (_req, res) => {
  const all = await cases();
  const out = [];
  for (const v of await store.col('vendors').all()) {
    const b = await series.baseline(v.id);
    out.push({
      id: v.id, name: v.name, domain: v.domain, bankLast4: v.bank.last4, bankVerifiedAt: v.bank.verifiedAt,
      lastPayment: b.rows.at(-1) ? { ts: b.rows.at(-1).ts, amount: b.rows.at(-1).amount } : null, averagePayment: b.mean,
      openHolds: all.filter((r) => r.vendorId === v.id && r.status === 'held').length,
      blocked: all.filter((r) => r.vendorId === v.id && r.status === 'blocked').length,
    });
  }
  res.json(out);
}));

// Daily totals, from the vendor_daily continuous aggregate when Tiger Data is live.
app.get('/api/vendors/:id/history', wrap(async (req, res) => res.json(await series.daily(req.params.id))));

app.get('/api/metrics/overview', wrap(async (_req, res) => res.json(await overview())));

// Everything the dashboard needs in one call.
app.get('/api/state', wrap(async (_req, res) => {
  res.json({
    company: cfg.company, approver: cfg.approverName, integrations: integrations(),
    simulator: notifier.kind === 'simulator',
    scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label, hint: s.hint })),
    cases: (await cases()).map(summary),
    stats: await overview(),
    messages: (await store.col('messages').all()).sort((a, b) => a.ts.localeCompare(b.ts)),
    ledger: (await ledger.entries()).reverse(),
    ledgerCheck: await ledger.verify(),
  });
}));

// ---- messaging, bank hook, ledger, seed ------------------------------------

// The on-screen phone. Disabled once a real Photon line is connected.
app.post('/api/sms/reply', wrap(async (req, res) => {
  if (notifier.kind !== 'simulator') return res.status(403).json({ error: 'Photon is live: reply from the approver\'s phone' });
  res.json({ answer: await notifier.receive(String(req.body.text || ''), cfg.approverName) });
}));

// Nessie decision hook: the bank asks before a transfer settles. Only transfers to a
// verified vendor account are approved, so money cannot leave around Countersign.
app.post('/api/webhooks/nessie', wrap(async (req, res) => {
  if (!bank.decideHook) return res.status(404).json({ error: 'Nessie is not configured' });
  const out = await bank.decideHook(req.rawBody?.toString('utf8') || '{}', req.get('Nessie-Signature'), await store.col('vendors').all());
  res.status(out.status).json(out.body);
}));

app.get('/api/ledger/verify', wrap(async (_req, res) => res.json(await ledger.verify())));

app.post('/api/seed', wrap(async (_req, res) => {
  await seed({ store, series, bank });
  emit('reset', {});
  res.json({ vendors: (await store.col('vendors').all()).length, payments: (await series.paid()).length, signins: (await store.col('signins').all()).length });
}));

app.listen(cfg.port, () => {
  console.log(`Countersign guarding ${cfg.company} on http://localhost:${cfg.port}`);
  for (const [k, v] of Object.entries(integrations())) console.log(`  ${v.live ? 'live' : 'demo'}  ${k.padEnd(8)} ${v.detail}`);
});
