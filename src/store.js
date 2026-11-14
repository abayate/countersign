// Document store. MongoDB Atlas when MONGODB_URI is set, otherwise a JSON file.
// Collections: vendors, requests, signins, bankChanges, messages, ledger, payments, meta.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { cfg } from './config.js';
import { similarity } from './text.js';

class LocalStore {
  kind = 'local';
  #data = {};
  #timer = null;
  constructor(file) {
    this.file = file === 'memory' ? null : file;
    if (this.file && existsSync(this.file)) {
      try { this.#data = JSON.parse(readFileSync(this.file, 'utf8')); } catch { this.#data = {}; }
    }
  }
  #save() {
    if (!this.file || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.#data));
    }, 150);
    this.#timer.unref?.();
  }
  col(name) {
    const docs = (this.#data[name] ??= {});
    return {
      all: async () => Object.values(docs).map((d) => structuredClone(d)),
      get: async (id) => (docs[id] ? structuredClone(docs[id]) : null),
      put: async (doc) => { docs[doc.id] = structuredClone(doc); this.#save(); return doc; },
    };
  }
  async reset() { this.#data = {}; this.#save(); }
  async searchVendors(name) { return rankVendors(await this.col('vendors').all(), name); }
}

class MongoStore {
  kind = 'mongodb';
  constructor(client, db) { this.client = client; this.db = db; }
  col(name) {
    const c = this.db.collection(name);
    const strip = (d) => { if (!d) return null; const { _id, ...rest } = d; return rest; };
    return {
      all: async () => (await c.find().toArray()).map(strip),
      get: async (id) => strip(await c.findOne({ _id: id })),
      put: async (doc) => { await c.replaceOne({ _id: doc.id }, { ...doc }, { upsert: true }); return doc; },
    };
  }
  async reset() {
    for (const { name } of await this.db.listCollections().toArray()) await this.db.collection(name).deleteMany({});
  }
  // Look-alike vendor search: Atlas Search fuzzy match when an index exists, else in-app ranking.
  async searchVendors(name) {
    if (cfg.atlasSearchIndex) {
      try {
        const hits = await this.db.collection('vendors').aggregate([
          { $search: { index: cfg.atlasSearchIndex, text: { query: name, path: 'name', fuzzy: { maxEdits: 2 } } } },
          { $limit: 5 },
        ]).toArray();
        if (hits.length) return rankVendors(hits.map(({ _id, ...v }) => v), name);
      } catch (err) {
        console.warn('[mongodb] Atlas Search unavailable, ranking in-app:', err.message);
      }
    }
    return rankVendors(await this.col('vendors').all(), name);
  }
}

function rankVendors(vendors, name) {
  return vendors
    .map((vendor) => ({ vendor, score: similarity(name, vendor.name) }))
    .filter((h) => h.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export async function initStore() {
  if (cfg.mongoUri) {
    try {
      const { MongoClient } = await import('mongodb');
      const client = new MongoClient(cfg.mongoUri, { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      console.log('[mongodb] connected');
      return new MongoStore(client, client.db(cfg.mongoDb));
    } catch (err) {
      console.warn('[mongodb] connection failed, using local store:', err.message);
    }
  }
  return new LocalStore(cfg.dataFile);
}

export async function nextSeq(store, key, start) {
  const meta = store.col('meta');
  const doc = (await meta.get(key)) || { id: key, n: start };
  doc.n += 1;
  await meta.put(doc);
  return doc.n;
}
