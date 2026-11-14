// Small string helpers shared by the checks.

export function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

const SUFFIXES = /\b(inc|llc|ltd|co|corp|corporation|company|limited|gmbh)\b\.?/g;
export const normName = (s = '') =>
  s.toLowerCase().replace(/&/g, ' and ').replace(SUFFIXES, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// 0..1, 1 = identical after normalising company suffixes and punctuation.
export function similarity(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

// Collapse the character swaps attackers use to make a domain look right.
export const deglyph = (d = '') =>
  d.toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1|]/g, 'l').replace(/5/g, 's');

// True when `domain` is not `real` but would pass for it at a glance.
export function isLookalikeDomain(domain, real) {
  if (!domain || !real || domain === real) return false;
  const a = deglyph(domain), b = deglyph(real);
  if (a === b) return true;
  const base = (d) => (d.split('.').slice(0, -1).join('.') || d).replace(/[^a-z0-9]/g, '');
  if (base(a) === base(b)) return true; // same name, different TLD
  return base(b).length >= 6 && levenshtein(base(a), base(b)) <= 2;
}

export const money = (n) =>
  Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export const maskAcct = (a = '') => (a ? `••••${String(a).slice(-4)}` : '—');
export const bankKey = (b) => (b?.routing && b?.account ? `${b.routing}:${b.account}` : '');
