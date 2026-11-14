# Handoff prompt

Paste everything below the line into a coding agent opened in a clone of this repo. Fill in the two bracketed lines first.

---

You are picking up Countersign, a HackPrinceton Fall 2026 project, from a teammate. The repo is https://github.com/nmea002/countersign. The submission deadline is 8:00 AM Eastern on Sunday, November 15, 2026, on Devpost, and it is a hard deadline. I am [your name], and today I am responsible for [which steps below].

## What Countersign is

An agent that checks every outgoing payment request before money leaves a company's bank account. It reads an invoice (PDF or email), compares it with the vendor's record and payment history, and either pays it or holds it and texts an approver, who replies APPROVE, HOLD or WHY. Decisions go to a tamper-evident ledger. The fraud it targets is the fake "our bank details have changed" invoice.

Read `README.md` first: it has the architecture, the API table, the integration table and the demo script. `docs/SUBMISSION.md` has the Devpost draft and a per-prize checklist.

## Current state

Working and tested in demo mode (`npm install`, `npm start`, `npm test`; 12 tests pass, no keys needed):

- The full loop: invoice in, extraction, fifteen checks, investigation, verdict, pay or hold, text, reply, ledger.
- Seven demo scenarios, PDF upload, raw email paste, the dashboard, and every route in the README's API table.
- A case file with numbered evidence and a timeline, and links between cases that share an IP address or bank account.

Written from each service's documentation but never run with real credentials: Gemini, MongoDB Atlas, Tiger Data, Capital One Nessie v2, Photon 2.0. Solana was run as far as devnet rejecting an unfunded key. Treat every one of these as unverified until you have seen it work.

Each integration sits behind one file with a local stand-in, and the app falls back to the stand-in if a service fails at startup:

| Integration | File | Env vars |
|---|---|---|
| Gemini | `src/llm.js` | `GEMINI_API_KEY`, `GEMINI_MODEL` |
| MongoDB Atlas | `src/store.js` | `MONGODB_URI`, `MONGODB_DB`, `ATLAS_SEARCH_INDEX` |
| Tiger Data | `src/timeseries.js` | `TIGER_DATABASE_URL` |
| Nessie v2 | `src/bank.js` | `NESSIE_API_KEY`, `NESSIE_URL`, `PUBLIC_URL` |
| Solana | `src/ledger.js`, `scripts/solana-setup.js` | `SOLANA_SECRET_KEY`, `SOLANA_RPC_URL` |
| Photon 2.0 | `src/notify.js` | `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_PLATFORM`, `PHOTON_APPROVER_HANDLE` |

## Rules for this work

- Keep demo mode working. The app must still start and pass `npm test` with an empty `.env` after every change.
- The risk score and the hold or clear decision stay in deterministic code (`src/checks.js`). The model reads invoices and writes explanations; it never decides.
- Never store a full bank account number. Use `toBank()` in `src/text.js`, which keeps a fingerprint and the last four digits.
- Never commit `.env` or any key. Use only synthetic data.
- Do not assume an API from memory. Nessie's v2 API and Photon 2.0 both differ from older versions; read the current docs before changing those adapters: `https://v2.nessieisreal.com/openapi.json` and `https://photon.codes/docs/llms.txt` (Beta pages only).
- After each step: run `npm test`, start the server, press **Reset demo**, run the "bank details have changed" scenario, then commit and push. Tell me plainly what you verified and what you could not.

## Steps, in order

### 1. Switch on each integration and fix what breaks

Do them one at a time. For each: I put the key in `.env`, you restart, press **Reset demo**, run the scenarios, and fix the adapter until the header pill shows "live" and the behaviour is right.

1. **Nessie v2.** Key from `https://v2.nessieisreal.com/account`. Check that Reset demo creates the customer, the operating account and six payee accounts, that a cleared invoice produces a completed transfer, and that the balance tile changes.
2. **Gemini.** Check that a PDF case shows "Read by: Gemini" and that the verdict text cites evidence ids.
3. **Photon.** Create a project at `https://app.photon.codes/dashboard`, add iMessage, and add the approver's own number. The approver must text the agent's number once before any hold can be delivered. Check a hold arrives on the phone and that `HOLD <number>` and `APPROVE <number>` work from it.
4. **MongoDB Atlas.** Check that the `vendors` and `cases` collections fill. Then create an Atlas Search index on `vendors.name`, set `ATLAS_SEARCH_INDEX`, and check the look-alike vendor scenario still resolves to Meridian Office Supply.
5. **Tiger Data.** Check that `payments` is a hypertable, that `vendor_daily` exists and has rows after Reset demo, and that `GET /api/vendors/v-cascade/history` returns data from it.
6. **Solana.** Run `node scripts/solana-setup.js`, fund the printed public key at `https://faucet.solana.com`, put the key line in `.env`, and check that ledger entries gain an "on Solana devnet" link that opens in the explorer.

### 2. Deepen what the prize judges look for

Do these only after step 1 works. Stop and move to step 3 by midnight even if some are unfinished.

1. **Link graph (Arlequin forensics).** Add a view on the case page that draws vendors, bank accounts, IP addresses, portal sessions and cases as a graph, using the indicators already stored on each case (`indicators`, `caseFile`). The demo data already has one IP shared by the fake email and the hijacked portal session.
2. **Ask the case (Arlequin, Gemini, Photon).** Let the investigator ask a question about a case in the dashboard and by text. Gemini answers only from that case file and must cite evidence ids; if the case file does not contain the answer, it says so.
3. **Serve the dashboard chart from Tiger Data.** Use `GET /api/vendors/:id/history` (the continuous aggregate) for the vendor chart, and add an overview chart of paid, held and declined amounts over time.
4. **Verify on chain (Solana).** Add a button that fetches a ledger entry's memo from devnet and compares it with the local hash.
5. **Nessie decision hook.** After deploying, set `PUBLIC_URL` and Reset demo so the hook registers. Then create a transfer to an unknown account directly through the Nessie API and check Countersign declines it.

### 3. Deploy

1. Create a Vultr Ubuntu instance and register a domain through the MLH GoDaddy Registry offer. Point the domain's A record at the instance.
2. On the instance, run `deploy/vultr-cloud-init.sh` with `REPO` and `DOMAIN` set, then put the real keys in `/opt/countersign/.env`, set `PUBLIC_URL=https://<domain>`, and bring the compose stack up again.
3. Check the site loads over HTTPS, press Reset demo, and run the demo script from the README end to end on the live URL.

These deploy files have never been run. Read them before using them.

### 4. Submit

1. Freeze features by about 4 AM. Rehearse the two-minute demo in `docs/SUBMISSION.md` and record a video under two minutes.
2. Update `docs/SUBMISSION.md` and the README's Status section so they describe what actually works with real credentials.
3. Submit on Devpost before 7 AM: repo link, video link, Discord usernames, main track Business and Enterprise, and each special track we qualify for.
4. Publish the DEV post draft from `docs/SUBMISSION.md` after submitting.

## Things only a person can do

Ask me for these; do not invent them.

- **Peri Forward Deployed.** The entry needs a real business we consulted: its name, the person's name and role, and one piece of evidence (a photo, a screenshot or a quote). Without these, do not opt in.
- **SpaceXSI raffle.** It requires Cursor as the core coding agent and a Grok Bot automation, both described in the project text. Most of this repo was built with Claude Code. Describe only tools that were really used, and skip the opt-in if that does not meet the rule.
- **ChatOverflow.** Connecting a coding agent at `https://chatoverflow.dev` is enough for the raffle.
- **Accounts and keys** for every service above, and the in-person demo on Sunday between 9:30 AM and 2:30 PM.

## Known limits to mention honestly

- The dashboard and API have no login.
- Invoice and case are one MongoDB document (`cases`), not two collections.
- The worker (reminders, Photon polling) runs inside the server process, not as a separate one.
- Email arrives by paste or API, not from a live inbox.
