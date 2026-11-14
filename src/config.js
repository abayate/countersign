import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const e = process.env;

export const cfg = {
  port: Number(e.PORT || 3000),
  dataFile: e.COUNTERSIGN_DATA || 'data/db.json', // "memory" keeps everything in RAM
  company: e.COMPANY_NAME || 'Tidewater Brewing Co.',
  approverName: e.APPROVER_NAME || 'Dana (Controller)',

  geminiKey: e.GEMINI_API_KEY || '',
  geminiModel: e.GEMINI_MODEL || 'gemini-2.5-flash',

  mongoUri: e.MONGODB_URI || '',
  mongoDb: e.MONGODB_DB || 'countersign',
  atlasSearchIndex: e.ATLAS_SEARCH_INDEX || '', // optional Atlas Search index on vendors.name

  tigerUrl: e.TIGER_DATABASE_URL || e.TIMESCALE_URL || '',

  nessieKey: e.NESSIE_API_KEY || '',
  nessieBase: e.NESSIE_URL || 'https://v2-prod-api.nessieisreal.com',
  publicUrl: (e.PUBLIC_URL || '').replace(/\/$/, ''), // set when deployed, enables the Nessie decision hook

  solanaSecret: e.SOLANA_SECRET_KEY || '', // JSON byte array, as written by scripts/solana-setup.js
  solanaRpc: e.SOLANA_RPC_URL || 'https://api.devnet.solana.com',

  photonKey: e.PHOTON_API_KEY || '',
  photonProject: e.PHOTON_PROJECT_ID || '',
  photonPlatform: e.PHOTON_PLATFORM || 'imessage',
  photonApprover: e.PHOTON_APPROVER_HANDLE || '', // the approver's own phone, E.164
  photonAgent: e.PHOTON_AGENT_HANDLE || '', // the number Photon assigned to the agent
};

export function integrations() {
  const on = (live, liveLabel, fallback) => ({ live: !!live, detail: live ? liveLabel : fallback });
  return {
    gemini: on(cfg.geminiKey, cfg.geminiModel, 'rule-based extractor'),
    mongodb: on(cfg.mongoUri, `Atlas · ${cfg.mongoDb}`, 'local JSON store'),
    tiger: on(cfg.tigerUrl, 'hypertable + continuous aggregate', 'in-process time series'),
    nessie: on(cfg.nessieKey, 'Capital One Nessie v2', 'mock bank'),
    solana: on(cfg.solanaSecret, 'devnet memo anchor', 'local hash chain only'),
    photon: on(cfg.photonKey && cfg.photonProject && cfg.photonApprover, cfg.photonPlatform, 'on-screen phone simulator'),
  };
}
