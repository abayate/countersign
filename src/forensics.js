// Forensics: turns raw email headers, vendor-portal sign-in logs and bank-detail
// change records into numbered evidence and one ordered timeline (the case file).

const DAY = 86400000;
const addrOf = (s = '') => (s.match(/<([^>]+)>/)?.[1] || s).trim().toLowerCase();
const domainOf = (addr = '') => addr.split('@')[1] || '';

export function parseEmail(raw) {
  const [head, ...rest] = raw.replace(/\r\n/g, '\n').split('\n\n');
  const body = rest.join('\n\n');
  const lines = head.replace(/\n[ \t]+/g, ' ').split('\n'); // unfold continuation lines
  const all = (name) => lines.filter((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':')).map((l) => l.slice(name.length + 1).trim());
  const one = (name) => all(name)[0] || '';
  const auth = one('Authentication-Results');
  const res = (k) => auth.match(new RegExp(`${k}=(\\w+)`, 'i'))?.[1]?.toLowerCase() || 'none';
  const from = addrOf(one('From'));
  const replyTo = addrOf(one('Reply-To'));
  const returnPath = addrOf(one('Return-Path'));
  return {
    subject: one('Subject'), date: one('Date'), messageId: one('Message-ID'),
    fromName: one('From').replace(/<[^>]+>/, '').replace(/"/g, '').trim(),
    from, fromDomain: domainOf(from),
    replyTo, replyToDomain: domainOf(replyTo),
    returnPath, returnPathDomain: domainOf(returnPath),
    auth: { spf: res('spf'), dkim: res('dkim'), dmarc: res('dmarc'), raw: auth },
    received: all('Received').map((r) => ({
      host: r.match(/from\s+(\S+)/i)?.[1] || '', ip: r.match(/\((?:[^)]*?)(\d{1,3}(?:\.\d{1,3}){3})\)/)?.[1] || '', raw: r,
    })),
    body,
  };
}

// Collects evidence as the investigation runs. Every finding cites evidence ids.
export class CaseFile {
  evidence = [];
  timeline = [];
  add(source, label, excerpt) {
    const id = `E${this.evidence.length + 1}`;
    this.evidence.push({ id, source, label, excerpt });
    return id;
  }
  event(ts, source, label, { suspicious = false, evidence = [] } = {}) {
    this.timeline.push({ ts, source, label, suspicious, evidence });
  }
  toJSON() {
    return { evidence: this.evidence, timeline: [...this.timeline].sort((a, b) => a.ts.localeCompare(b.ts)) };
  }
}

// Sign-in log analysis for one vendor's portal account. Flags sessions that break the
// account's own history (new country, new device, burst of failures before a success)
// and ties them to any bank-detail change made in that session.
export function analyseSignins(signins, bankChanges, now = Date.now()) {
  const sorted = [...signins].sort((a, b) => a.ts.localeCompare(b.ts));
  const recentCut = now - 14 * DAY;
  const history = sorted.filter((s) => Date.parse(s.ts) < recentCut && s.ok);
  const knownCountries = new Set(history.map((s) => s.country));
  const knownDevices = new Set(history.map((s) => s.device));
  const anomalies = [];
  for (const s of sorted.filter((x) => Date.parse(x.ts) >= recentCut && x.ok)) {
    const reasons = [];
    if (knownCountries.size && !knownCountries.has(s.country)) reasons.push(`first sign-in from ${s.country}`);
    if (knownDevices.size && !knownDevices.has(s.device)) reasons.push('unrecognised device');
    const failsBefore = sorted.filter((f) => !f.ok && f.ip === s.ip && Date.parse(s.ts) - Date.parse(f.ts) >= 0 && Date.parse(s.ts) - Date.parse(f.ts) < 3600000).length;
    if (failsBefore >= 3) reasons.push(`${failsBefore} failed attempts from the same IP in the hour before`);
    const change = bankChanges.find((c) => c.sessionId && c.sessionId === s.sessionId);
    if (reasons.length) anomalies.push({ signin: s, reasons, change, failsBefore });
  }
  return { anomalies, knownCountries: [...knownCountries], historyCount: history.length };
}
