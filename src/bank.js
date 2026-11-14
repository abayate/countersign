// The bank Countersign guards. Capital One Nessie v2 when NESSIE_API_KEY is set,
// otherwise a mock with the same shape. The company has one operating account;
// each vendor has a payee account that payments are transferred to.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cfg } from './config.js';

const cents = (dollars) => Math.round(dollars * 100);

class MockBank {
  kind = 'mock';
  constructor(store) { this.store = store; }
  async #acct() { return (await this.store.col('meta').get('bank')) || { id: 'bank', balance: 0, accountId: 'mock-operating' }; }
  async setup(company, vendors, balance) {
    await this.store.col('meta').put({ id: 'bank', balance, accountId: 'mock-operating', company });
    return vendors.map((v) => ({ ...v, payeeAccountId: `mock-payee-${v.id}` }));
  }
  async balance() { return (await this.#acct()).balance; }
  async createBill(req) { return { billId: `mock-bill-${req.id}` }; }
  async closeBill() {}
  async newPayee(vendor) { return `mock-payee-${vendor.id}-${Date.now().toString(36)}`; }
  async pay(req) {
    const a = await this.#acct();
    a.balance = Math.round((a.balance - req.extracted.amount) * 100) / 100;
    await this.store.col('meta').put(a);
    return { ref: `mock-txn-${req.id}`, rail: 'mock bank transfer' };
  }
}

class NessieBank {
  kind = 'nessie';
  constructor(store) { this.store = store; }
  async #call(method, path, body) {
    const res = await fetch(`${cfg.nessieBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.nessieKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Nessie ${method} ${path} -> ${res.status} ${json.type || ''} ${json.detail || json.title || ''}`.trim());
    return json;
  }
  async #acct() { return this.store.col('meta').get('bank'); }
  #address = { street_number: '20', street_name: 'Washington Rd', city: 'Princeton', state: 'NJ', zip: '08544' };

  // Creates the company (customer + operating account) and one payee account per vendor.
  async setup(company, vendors, balance) {
    const co = await this.#call('POST', '/customers', { first_name: company.slice(0, 80), last_name: 'Accounts Payable', address: this.#address });
    const op = await this.#call('POST', `/customers/${co.id}/accounts`, { type: 'Checking', nickname: `${company} Operating`.slice(0, 80), balance_cents: cents(balance) });
    const vc = await this.#call('POST', '/customers', { first_name: 'Approved', last_name: 'Vendors', address: this.#address });
    const meta = { id: 'bank', customerId: co.id, accountId: op.id, vendorCustomerId: vc.id, company };
    const out = [];
    for (const v of vendors) {
      const a = await this.#call('POST', `/customers/${vc.id}/accounts`, { type: 'Checking', nickname: v.name.slice(0, 80), balance_cents: 0 });
      out.push({ ...v, payeeAccountId: a.id });
    }
    // Bank-side gate: with a public URL, Nessie asks Countersign before any transfer settles.
    if (cfg.publicUrl) {
      try {
        const hook = await this.#call('POST', '/webhooks', { mode: 'decision', url: `${cfg.publicUrl}/api/webhooks/nessie`, kinds: ['transfer'], on_error: 'decline' });
        meta.hookId = hook.id; meta.hookSecret = hook.secret;
      } catch (err) { console.warn('[nessie] decision hook not registered:', err.message); }
    }
    await this.store.col('meta').put(meta);
    return out;
  }
  async balance() {
    const a = await this.#acct();
    return a ? (await this.#call('GET', `/accounts/${a.accountId}`)).available_cents / 100 : 0;
  }
  async createBill(req) {
    const a = await this.#acct();
    const b = await this.#call('POST', `/accounts/${a.accountId}/bills`, {
      status: 'pending', payee: String(req.vendorName).slice(0, 80), nickname: req.extracted.invoiceNumber || req.id, payment_amount: req.extracted.amount,
    });
    return { billId: b.id };
  }
  async closeBill(billId, status) { // 'completed' | 'cancelled'
    if (billId) await this.#call('PATCH', `/bills/${billId}`, { status });
  }
  // A verified change of bank details means a new account to pay.
  async newPayee(vendor) {
    const a = await this.#acct();
    return (await this.#call('POST', `/customers/${a.vendorCustomerId}/accounts`, { type: 'Checking', nickname: `${vendor.name} (updated)`.slice(0, 80), balance_cents: 0 })).id;
  }
  async pay(req, vendor) {
    const a = await this.#acct();
    const txn = await this.#call('POST', `/accounts/${a.accountId}/transfers`, {
      amount_cents: cents(req.extracted.amount), payee_id: vendor.payeeAccountId, description: `${req.id} ${req.extracted.invoiceNumber || ''}`.trim(),
    });
    const done = await this.#call('POST', `/transactions/${txn.id}/settle`).catch(() => txn); // skip the pending window
    if (done.status === 'declined' || done.status === 'cancelled') throw new Error(`transfer ${done.status}: ${done.decision_reason || 'no reason given'}`);
    return { ref: txn.id, rail: 'Nessie transfer', bankStatus: done.status };
  }
  // Decision hook: approve a pending transfer only when it goes to a verified vendor account.
  async decideHook(rawBody, signature, vendors) {
    const meta = await this.#acct();
    if (meta?.hookSecret) {
      const parts = Object.fromEntries(String(signature || '').split(',').map((p) => p.split('=')));
      const want = createHmac('sha256', meta.hookSecret).update(`${parts.t}.`).update(rawBody).digest('hex');
      const ok = parts.v1 && parts.v1.length === want.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(want));
      if (!ok) return { status: 401, body: { error: 'bad signature' } };
    }
    const txn = JSON.parse(rawBody).transaction || {};
    const known = vendors.some((v) => v.payeeAccountId && v.payeeAccountId === txn.payee_id);
    return { status: 200, body: known ? { decision: 'approve' } : { decision: 'decline', reason: 'Payee is not a verified vendor account in Countersign' } };
  }
}

export function initBank(store) {
  return cfg.nessieKey ? new NessieBank(store) : new MockBank(store);
}
export { MockBank };
