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
app.use(express.json({ limit: '1mb' }));
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
const summary = (r) => ({
  id: r.id, n: r.n, receivedAt: r.receivedAt, status: r.status, vendorName: r.vendorName,
  amount: r.extracted?.amount ?? null, invoiceNumber: r.extracted?.invoiceNumber ?? null,
  risk: r.verdict?.risk ?? null, decision: r.verdict?.decision ?? null, top: r.verdict?.findings?.[0]?.title ?? null,
});

app.get('/api/state', wrap(async (_req, res) => {
  const requests = (await store.col('requests').all()).sort((a, b) => b.n - a.n);
  const sum = (st) => requests.filter((r) => st.includes(r.status)).reduce((a, r) => a + (r.extracted?.amount || 0), 0);
  res.json({
    company: cfg.company, approver: cfg.approverName, integrations: integrations(),
    simulator: notifier.kind === 'simulator',
    scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label, hint: s.hint })),
    requests: requests.map(summary),
    stats: {
      balance: await bank.balance().catch(() => null),
      paid: sum(['paid']), paidCount: requests.filter((r) => r.status === 'paid').length,
      held: sum(['held']), heldCount: requests.filter((r) => r.status === 'held').length,
      blocked: sum(['blocked']), blockedCount: requests.filter((r) => r.status === 'blocked').length,
    },
    messages: (await store.col('messages').all()).sort((a, b) => a.ts.localeCompare(b.ts)),
    ledger: (await ledger.entries()).reverse(),
    ledgerCheck: await ledger.verify(),
  });
}));

app.get('/api/requests/:id', wrap(async (req, res) => {
  const r = await store.col('requests').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const vendor = r.vendorId ? await store.col('vendors').get(r.vendorId) : null;
  const baseline = vendor ? await series.baseline(vendor.id) : null;
  res.json({ request: r, vendor, baseline });
}));

// A new payment request: a raw email, or one of the demo scenarios.
app.post('/api/inbound', wrap(async (req, res) => {
  const raw = req.body.raw || SCENARIOS[req.body.scenario]?.build();
  if (!raw) return res.status(400).json({ error: 'send {raw} or a known {scenario}' });
  const p = agent.process(raw);
  if (req.body.wait) return res.json(summary(await p));
  p.catch((err) => console.error('[agent]', err));
  res.status(202).json({ accepted: true });
}));

app.post('/api/requests/:id/decision', wrap(async (req, res) => {
  if (!['approve', 'hold'].includes(req.body.action)) return res.status(400).json({ error: 'action must be approve or hold' });
  res.json(summary(await agent.decide(req.params.id, req.body.action, `${cfg.approverName} via dashboard`)));
}));

// The on-screen phone. Disabled once a real Photon line is connected.
app.post('/api/sms/reply', wrap(async (req, res) => {
  if (notifier.kind !== 'simulator') return res.status(403).json({ error: 'Photon is live: reply from the approver\'s phone' });
  res.json({ answer: await notifier.receive(String(req.body.text || ''), cfg.approverName) });
}));

app.get('/api/ledger/verify', wrap(async (_req, res) => res.json(await ledger.verify())));

app.post('/api/reset', wrap(async (_req, res) => {
  await seed({ store, series, bank });
  emit('reset', {});
  res.json({ ok: true });
}));

app.listen(cfg.port, () => {
  console.log(`Countersign guarding ${cfg.company} on http://localhost:${cfg.port}`);
  for (const [k, v] of Object.entries(integrations())) console.log(`  ${v.live ? 'live' : 'demo'}  ${k.padEnd(8)} ${v.detail}`);
});
