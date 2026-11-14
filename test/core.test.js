// End-to-end tests of the core loop, in memory with every integration in demo mode.
process.env.COUNTERSIGN_DATA = 'memory';
for (const k of ['GEMINI_API_KEY', 'MONGODB_URI', 'TIGER_DATABASE_URL', 'TIMESCALE_URL', 'NESSIE_API_KEY', 'SOLANA_SECRET_KEY', 'PHOTON_API_KEY']) process.env[k] = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { initStore } = await import('../src/store.js');
const { initSeries } = await import('../src/timeseries.js');
const { MockBank } = await import('../src/bank.js');
const { Ledger } = await import('../src/ledger.js');
const { Notifier } = await import('../src/notify.js');
const { Agent } = await import('../src/agent.js');
const { seed, SCENARIOS } = await import('../src/seed.js');

async function world() {
  const store = await initStore();
  const series = await initSeries(store);
  const bank = new MockBank(store);
  const ledger = new Ledger(store);
  const notifier = new Notifier(store);
  const agent = new Agent({ store, series, bank, ledger, notifier });
  await seed({ store, series, bank });
  return { store, series, bank, ledger, notifier, agent };
}
const codes = (r) => r.verdict.findings.map((f) => f.code);
const texts = async (w) => (await w.store.col('messages').all()).sort((a, b) => a.ts.localeCompare(b.ts));

test('routine invoice is cleared and paid without bothering the approver', async () => {
  const w = await world();
  const before = await w.bank.balance();
  const r = await w.agent.process(SCENARIOS.legit.build());
  assert.equal(r.verdict.decision, 'clear');
  assert.equal(r.status, 'paid');
  assert.equal(r.verdict.risk, 0);
  assert.equal(await w.bank.balance(), before - 9742.5);
  assert.equal((await texts(w)).length, 0);
});

test('"bank details have changed" email is held and the approver is texted', async () => {
  const w = await world();
  const before = await w.bank.balance();
  const r = await w.agent.process(SCENARIOS.bec.build());
  assert.equal(r.status, 'held');
  for (const c of ['BANK_CHANGE', 'DOMAIN_LOOKALIKE', 'AUTH_FAIL', 'REPLY_TO_MISMATCH', 'URGENCY']) assert.ok(codes(r).includes(c), c);
  assert.equal(r.vendorId, 'v-northwind');
  assert.equal(await w.bank.balance(), before, 'no money moved');
  const [sms] = await texts(w);
  assert.match(sms.text, /HOLD/);
  assert.match(sms.text, /\(609\) 555-0142/, 'tells the approver to call the number on file');
  // every finding cites evidence that exists in the case file
  const ids = new Set(r.caseFile.evidence.map((e) => e.id));
  for (const f of r.verdict.findings) for (const e of f.evidence) assert.ok(ids.has(e), `${f.code} cites ${e}`);
});

test('HOLD reply blocks the payment and blocklists the account for the next attempt', async () => {
  const w = await world();
  const r = await w.agent.process(SCENARIOS.bec.build());
  const answer = await w.notifier.receive(`HOLD ${r.n}`, 'Dana');
  assert.match(answer, /blocked/);
  assert.equal((await w.store.col('requests').get(r.id)).status, 'blocked');
  const again = await w.agent.process(SCENARIOS.bec.build());
  assert.ok(codes(again).includes('BANK_BLOCKLISTED'));
});

test('clean email with a hijacked portal account is caught by the sign-in logs', async () => {
  const w = await world();
  const r = await w.agent.process(SCENARIOS.takeover.build());
  assert.equal(r.status, 'held');
  assert.ok(!codes(r).includes('AUTH_FAIL') && !codes(r).includes('DOMAIN_LOOKALIKE'), 'email itself is clean');
  for (const c of ['BANK_CHANGE', 'SIGNIN_ANOMALY', 'CHANGE_THEN_INVOICE']) assert.ok(codes(r).includes(c), c);
  assert.ok(r.caseFile.timeline.some((e) => e.source === 'signin-log' && e.suspicious));
  const ts = r.caseFile.timeline.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort(), 'timeline is in order');
});

test('APPROVE reply pays and makes the new bank details the vendor master', async () => {
  const w = await world();
  const r = await w.agent.process(SCENARIOS.takeover.build());
  const answer = await w.notifier.receive('approve', 'Dana'); // number optional when one item waits
  assert.match(answer, /released/);
  assert.equal((await w.store.col('requests').get(r.id)).status, 'paid');
  const v = await w.store.col('vendors').get('v-summit');
  assert.equal(v.bank.account, '2290417786');
  assert.equal(v.bankHistory.length, 1);
});

test('look-alike vendor, duplicate invoice and amount spike are all held', async () => {
  const w = await world();
  const look = await w.agent.process(SCENARIOS.lookalike.build());
  assert.equal(look.status, 'held');
  assert.ok(codes(look).includes('NAME_LOOKALIKE') && codes(look).includes('PROMPT_INJECTION'));
  const dup = await w.agent.process(SCENARIOS.duplicate.build());
  assert.ok(codes(dup).includes('DUPLICATE_INVOICE'));
  assert.equal(dup.status, 'held');
  const spike = await w.agent.process(SCENARIOS.spike.build());
  assert.deepEqual(codes(spike), ['AMOUNT_ANOMALY']);
  assert.equal(spike.status, 'held');
});

test('unknown sender cannot be approved by text', async () => {
  const w = await world();
  const raw = SCENARIOS.legit.build().replaceAll('cascadepackaging.example', 'zephyr-consulting.example').replaceAll('Cascade Packaging', 'Zephyr Consulting');
  const r = await w.agent.process(raw);
  assert.ok(codes(r).includes('UNKNOWN_VENDOR'));
  assert.match(await w.notifier.receive(`APPROVE ${r.n}`, 'Dana'), /not an approved vendor/);
  assert.equal((await w.store.col('requests').get(r.id)).status, 'held');
});

test('decision ledger is a hash chain that detects tampering', async () => {
  const w = await world();
  const r = await w.agent.process(SCENARIOS.bec.build());
  await w.agent.decide(r.id, 'hold');
  await w.agent.process(SCENARIOS.legit.build());
  assert.deepEqual((await w.ledger.entries()).map((e) => e.action), ['hold', 'block', 'clear']);
  assert.equal((await w.ledger.verify()).ok, true);
  const e = (await w.ledger.entries())[0];
  await w.store.col('ledger').put({ ...e, action: 'clear' }); // rewrite history
  const check = await w.ledger.verify();
  assert.equal(check.ok, false);
  assert.equal(check.brokenAt, 1);
});

test('background worker reminds the approver once about an unanswered hold', async () => {
  const w = await world();
  const r = await w.agent.process(SCENARIOS.bec.build());
  assert.equal(await w.agent.remindStale(60000), 0, 'not stale yet');
  assert.equal(await w.agent.remindStale(0), 1);
  assert.equal(await w.agent.remindStale(0), 0, 'only one reminder');
  const all = await texts(w);
  assert.equal(all.length, 2);
  assert.ok(all.some((m) => m.text.startsWith('Reminder') && m.text.includes(r.id)));
});
