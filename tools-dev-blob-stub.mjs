// In-memory stand-in for @vercel/blob so the handlers run without touching the real ledger.
// It behaves like the real store where the code depends on it: get() of a missing
// blob is null, get() hands back a weak ETag (W/"..."), head() and put() strong
// ones, ifMatch is checked, and allowOverwrite:false refuses an existing blob.
export const store = new Map();
let n = 0;
const tagOf = () => '"e' + (++n) + '"';
export async function head(key) { const v = store.get(key); if (!v) throw new Error('not found'); return { etag: v.etag }; }
// failGets: the next n reads throw, as a store that is down would
export const knobs = { failGets: 0 };
export async function get(key) {
  if (knobs.failGets > 0) { knobs.failGets--; throw new Error('blob store unreachable'); }
  const v = store.get(key); if (!v) return null;
  return { stream: new Blob([v.body]).stream(), blob: { etag: 'W/' + v.etag } };
}
export async function put(key, body, opts = {}) {
  const v = store.get(key);
  if (v && opts.allowOverwrite === false) throw new Error('This blob already exists');
  if (opts.ifMatch && (!v || v.etag !== opts.ifMatch)) throw new Error('precondition failed');
  const etag = tagOf();
  store.set(key, { body: String(body), etag });
  return { etag, url: 'blob://' + key };
}
export function seed(key, obj) { store.set(key, { body: JSON.stringify(obj), etag: tagOf() }); }
export function read(key) { return JSON.parse(store.get(key).body); }
