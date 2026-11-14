// Payment history as a time series. Tiger Data (TimescaleDB) hypertable when
// TIGER_DATABASE_URL is set, otherwise the document store's `payments` collection.
import { cfg } from './config.js';

const DAY = 86400000;

export function stats(rows, monthly) {
  const amounts = rows.map((r) => r.amount);
  const n = amounts.length;
  const mean = n ? amounts.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const gaps = rows.slice(1).map((r, i) => (Date.parse(r.ts) - Date.parse(rows[i].ts)) / DAY).sort((a, b) => a - b);
  const medianGapDays = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  return {
    n, mean, sd, medianGapDays,
    lastTs: n ? rows[n - 1].ts : null,
    // floor the spread so a vendor billing an identical amount every month doesn't make z explode
    spread: Math.max(sd, mean * 0.05),
    rows, monthly: monthly || bucketMonthly(rows),
  };
}

function bucketMonthly(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.ts.slice(0, 7);
    m.set(k, (m.get(k) || 0) + r.amount);
  }
  return [...m].map(([month, total]) => ({ month, total }));
}

class LocalSeries {
  kind = 'local';
  constructor(store) { this.store = store; }
  async record(p) { await this.store.col('payments').put({ id: `${p.vendorId}:${p.ts}:${p.invoiceNumber}`, ...p }); }
  async history(vendorId) {
    return (await this.store.col('payments').all()).filter((p) => p.vendorId === vendorId).sort((a, b) => a.ts.localeCompare(b.ts));
  }
  async baseline(vendorId) { return stats(await this.history(vendorId)); }
  async all() { return this.store.col('payments').all(); }
  async reset() {}
}

class TigerSeries {
  kind = 'tiger';
  constructor(pool) { this.pool = pool; }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS payments (
      ts timestamptz NOT NULL, vendor_id text NOT NULL, amount double precision NOT NULL,
      invoice_number text, request_id text, bank_key text)`);
    await this.pool.query(`SELECT create_hypertable('payments', 'ts', if_not_exists => TRUE, migrate_data => TRUE)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS payments_vendor_ts ON payments (vendor_id, ts DESC)`);
  }
  async record(p) {
    await this.pool.query(
      'INSERT INTO payments (ts, vendor_id, amount, invoice_number, request_id, bank_key) VALUES ($1,$2,$3,$4,$5,$6)',
      [p.ts, p.vendorId, p.amount, p.invoiceNumber || null, p.requestId || null, p.bankKey || null]);
  }
  #row = (r) => ({ ts: new Date(r.ts).toISOString(), vendorId: r.vendor_id, amount: r.amount, invoiceNumber: r.invoice_number, requestId: r.request_id, bankKey: r.bank_key });
  async history(vendorId) {
    const { rows } = await this.pool.query('SELECT * FROM payments WHERE vendor_id = $1 ORDER BY ts', [vendorId]);
    return rows.map(this.#row);
  }
  async baseline(vendorId) {
    const { rows } = await this.pool.query(
      `SELECT to_char(time_bucket('1 month', ts), 'YYYY-MM') AS month, sum(amount) AS total
         FROM payments WHERE vendor_id = $1 GROUP BY 1 ORDER BY 1`, [vendorId]);
    return stats(await this.history(vendorId), rows.map((r) => ({ month: r.month, total: Number(r.total) })));
  }
  async all() { return (await this.pool.query('SELECT * FROM payments ORDER BY ts')).rows.map(this.#row); }
  async reset() { await this.pool.query('TRUNCATE payments'); }
}

export async function initSeries(store) {
  if (cfg.tigerUrl) {
    try {
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({ connectionString: cfg.tigerUrl, max: 4, connectionTimeoutMillis: 8000 });
      const series = new TigerSeries(pool);
      await series.init();
      console.log('[tiger] hypertable ready');
      return series;
    } catch (err) {
      console.warn('[tiger] unavailable, using in-process series:', err.message);
    }
  }
  return new LocalSeries(store);
}
