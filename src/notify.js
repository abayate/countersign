// Texts the approver and receives their replies. Photon (iMessage/SMS) when
// configured; otherwise the dashboard's on-screen phone plays the approver.
// Every message, either way, is kept in the `messages` collection.
import { randomUUID } from 'node:crypto';
import { cfg } from './config.js';

export class Notifier {
  kind = 'simulator';
  constructor(store, emit = () => {}) { this.store = store; this.emit = emit; this.onReply = async () => ''; }

  async log(dir, text, extra = {}) {
    const msg = { id: randomUUID(), ts: new Date().toISOString(), dir, text, channel: this.kind, ...extra };
    await this.store.col('messages').put(msg);
    this.emit('message', { id: msg.id });
    return msg;
  }
  async send(text, extra) { return this.log('out', text, extra); }

  // An approver reply, from Photon or from the simulator. Returns the agent's answer.
  async receive(text, actor) {
    await this.log('in', text, { actor });
    const answer = await this.onReply(text, actor);
    if (answer) await this.send(answer);
    return answer;
  }
  start() {}
}

export class PhotonNotifier extends Notifier {
  kind = 'photon';
  #photon; #seen = new Set(); #since = new Date(Date.now() - 5000).toISOString();

  async #space() { return this.store.col('meta').get('photonSpace'); }

  async send(text, extra) {
    const space = await this.#space();
    if (!space) {
      // A shared Photon line cannot send the first message; the approver texts the agent once to open the thread.
      return this.log('out', text, { ...extra, delivery: 'queued: approver has not texted the agent yet' });
    }
    try {
      await this.#photon.projects.sendMessage({
        path: { id: cfg.photonProject },
        headers: { 'idempotency-key': randomUUID() },
        body: { spaceId: space.spaceId, senderId: space.agentId, content: { type: 'text', format: 'plain', text } },
      });
      return this.log('out', text, { ...extra, delivery: 'accepted by Photon' });
    } catch (err) {
      console.warn('[photon] send failed:', err.message);
      return this.log('out', text, { ...extra, delivery: `failed: ${err.message}` });
    }
  }

  async start() {
    const { Photon } = await import('@photon-ai/api');
    this.#photon = new Photon({ headers: { Authorization: `Bearer ${cfg.photonKey}` } });
    const tick = async () => {
      try {
        const page = await this.#photon.projects.listMessages({
          path: { id: cfg.photonProject },
          query: { createdSince: this.#since, direction: 'received', order: 'asc', pageSize: 100, platform: cfg.photonPlatform },
        });
        for (const m of page.items) {
          if (this.#seen.has(m.id) || m.status !== 'received') continue;
          this.#seen.add(m.id);
          // Only the configured approver's own number can approve or hold anything.
          if (m.sentBy?.kind !== 'human' || m.sentBy.handle !== cfg.photonApprover) continue;
          if (m.content?.type !== 'text') continue;
          await this.store.col('meta').put({ id: 'photonSpace', spaceId: m.space.id, agentId: m.receivedBy.id });
          await this.receive(m.content.text.trim(), cfg.approverName);
        }
      } catch (err) {
        console.warn('[photon] poll failed:', err.message);
      }
    };
    setInterval(tick, 3000).unref();
    console.log(`[photon] polling ${cfg.photonPlatform} for replies from ${cfg.photonApprover}`);
  }
}

export function initNotifier(store, emit) {
  const live = cfg.photonKey && cfg.photonProject && cfg.photonApprover;
  return live ? new PhotonNotifier(store, emit) : new Notifier(store, emit);
}
