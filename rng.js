// treegen/rng — seeded randomness.
//
// Every stochastic stage in treegen draws from a *named sub-stream* derived
// from the one project seed. That matters: re-rolling the palette must not
// reshuffle vegetation placement, and dragging a node must not change how any
// existing leaf falls in winter. Named streams keep those independent.
//
// The generator is mulberry32, carried over from girard — small, fast, and
// good enough for visual work. It is NOT cryptographic.

// ---------- Core generator ----------

// Build a PRNG from a 32-bit integer seed. Returns a function yielding
// floats in [0, 1).
export function makeRng(seed) {
  let s = (seed | 0) >>> 0 || 1;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Hashing ----------

// FNV-1a over a string. Used to turn stream names and object IDs into seeds
// so we never depend on iteration order or array position.
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Combine integers into one well-mixed 32-bit value. The constants are the
// usual spatial-hash primes; the final avalanche keeps low bits from
// correlating when inputs differ by 1 (which they routinely do — seed + year).
export function mix(...nums) {
  let h = 0x9e3779b1;
  for (const n of nums) {
    h ^= Math.imul(n >>> 0 || 0, 0x85ebca6b);
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

// ---------- Named streams ----------

// The stages that consume randomness. Naming them here rather than passing
// bare strings around means a typo is a missing export, not a silently
// different stream.
export const STREAMS = {
  VORONOI: 'voronoi',
  LSYSTEM: 'lsystem',
  PLACEMENT: 'placement',
  TONE: 'tone',
  PALETTE: 'palette',
  WINTER: 'winter',
  SPRING: 'spring',
};

// A stage-level stream. Same (seed, name) always gives the same sequence.
export function sub(seed, name) {
  return makeRng(mix(seed, hashStr(name)));
}

// A per-object stream, keyed by the object's stable ID rather than its index.
// This is what lets a leaf keep its sway parameters across re-renders, node
// drags, and additions elsewhere in the tree — nothing about its neighbours
// can perturb it.
export function objRng(seed, id, name) {
  return makeRng(mix(seed, hashStr(name), hashStr(id)));
}

// ---------- Small helpers ----------

// Integer in [0, n).
export function randInt(rng, n) {
  return Math.floor(rng() * n);
}

// Float in [lo, hi).
export function range(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

// Uniform pick from a non-empty array.
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Pick from [{weight, value}, …]. Weights need not sum to 1. Used by shape
// rules ("70% circle / 30% path A") and palette substitution alike.
export function weighted(rng, entries) {
  let total = 0;
  for (const e of entries) total += e.weight > 0 ? e.weight : 0;
  if (!(total > 0)) return entries.length ? entries[0].value : null;
  let r = rng() * total;
  for (const e of entries) {
    const w = e.weight > 0 ? e.weight : 0;
    if (r < w) return e.value;
    r -= w;
  }
  return entries[entries.length - 1].value;
}
