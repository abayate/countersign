// The bank Countersign guards. Capital One Nessie when NESSIE_API_KEY is set,
// otherwise a mock with the same shape (operating account, merchants, bills, purchases).
import { cfg } from './config.js';

const today = () => new Date().toISOString().slice(0, 10);

class MockBank {
  kind = 'mock';
  constructor(store) { this.store = store; }
  async #acct() { return (await this.store.col('meta').get('bank')) || { id: 'bank', balance: 0, accountId: 'mock-operating' }; }
  async setup(company, vendors, balance) {
    await this.store.col('meta').put({ id: 'bank', balance, accountId: 'mock-operating', company });
    return vendors.map((v) => ({ ...v, merchantId: `mock-merchant-${v.id}` }));
  }
  async balance() { return (await this.#acct()).balance; }
  async createBill(req) { return { billId: `mock-bill-${req.id}` }; }
  async closeBill() {}
  async pay(req) {
    const a = await this.#acct();
    a.balance = Math.round((a.balance - req.extracted.amount) * 100) / 100;
    await this.store.col('meta').put(a);
    return { ref: `mock-txn-${req.id}`, rail: 'mock bank' };
  }
}

class NessieBank {
  kind = 'nessie';
  constructor(store) { this.store = store; }
  async #call(method, path, body) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${cfg.nessieBase}${path}${sep}key=${cfg.nessieKey}`, {
      method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Nessie ${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    return json;
  }
  async #acct() { return this.store.col('meta').get('bank'); }
  // Creates the company (customer + checking account) and one merchant per vendor.
  async setup(company, vendors, balance) {
    const cust = await this.#call('POST', '/customers', {
      first_name: company.split(' ')[0], last_name: 'Accounts Payable',
      address: { street_number: '20', street_name: 'Washington Rd', city: 'Princeton', state: 'NJ', zip: '08544' },
    });
    const customerId = cust.objectCreated._id;
    const acct = await this.#call('POST', `/customers/${customerId}/accounts`, {
      type: 'Checking', nickname: `${company} Operating`, rewards: 0, balance: Math.round(balance),
    });
    await this.store.col('meta').put({ id: 'bank', customerId, accountId: acct.objectCreated._id, company });
    const out = [];
    for (const v of vendors) {
      const m = await this.#call('POST', '/merchants', {
        name: v.name, category: [v.category || 'supplier'],
        address: { street_number: '1', street_name: 'Commerce St', city: 'Trenton', state: 'NJ', zip: '08608' },
        geocode: { lat: 40.22, lng: -74.76 },
      });
      out.push({ ...v, merchantId: m.objectCreated._id });
    }
    return out;
  }
  async balance() {
    const a = await this.#acct();
    return a ? (await this.#call('GET', `/accounts/${a.accountId}`)).balance : 0;
  }
  async createBill(req) {
    const a = await this.#acct();
    const r = await this.#call('POST', `/accounts/${a.accountId}/bills`, {
      status: 'pending', payee: req.vendorName, nickname: req.extracted.invoiceNumber || req.id,
      payment_date: today(), recurring_date: 1, payment_amount: req.extracted.amount,
    });
    return { billId: r.objectCreated._id };
  }
  async closeBill(billId, status) { // 'completed' | 'cancelled'
    if (billId) await this.#call('PUT', `/bills/${billId}`, { status });
  }
  async pay(req, vendor) {
    const a = await this.#acct();
    const r = await this.#call('POST', `/accounts/${a.accountId}/purchases`, {
      merchant_id: vendor.merchantId, medium: 'balance', purchase_date: today(),
      amount: req.extracted.amount, status: 'pending', description: `${req.id} ${req.extracted.invoiceNumber || ''}`.trim(),
    });
    return { ref: r.objectCreated._id, rail: 'Nessie purchase' };
  }
}

export function initBank(store) {
  return cfg.nessieKey ? new NessieBank(store) : new MockBank(store);
}
export { MockBank };
