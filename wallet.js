// Wallet connect, no framework. Finds Solana wallets two ways: the Wallet
// Standard, which is how Jupiter and every current wallet announces itself, and
// the older window globals a few wallets still inject. Then it asks the user to
// sign a sentence and hands the signature to /api/auth to be checked.
//
// Signing in never moves funds: it uses connect and signMessage, which wallets
// refuse to use for transactions. The one thing here that can move funds is
// approveTx, and only through the wallet's own approval screen.

const KEY = 'g00b_session';
export const NO_WALLET = 'No Solana wallet found. Install Phantom, Solflare, Backpack or Jupiter.';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const b of bytes) { if (b === 0) out += '1'; else break; }
  return out + digits.reverse().map((d) => B58[d]).join('');
}

function b58decode(str) {
  const bytes = [0];
  for (const ch of String(str)) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error('Not a valid key.');
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of String(str)) { if (ch === '1') bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}

// ---------- the pocket wallet ----------
// A wallet made in this browser, for laundry money kept apart from a main wallet.
// It starts as 12 recovery words (BIP39, made here from the browser's own
// randomness), and the key comes from them the way Phantom, Solflare and Backpack
// do it (SLIP-0010, m/44'/501'/0'/0'), so those words open the same wallet there.
// The words and the key are kept only in this browser's storage and never sent
// anywhere: the site gets signatures, nothing else. The key is the usual Solana
// 64 bytes (seed then public key) in base58. It has no approval screen of its
// own, so every transaction goes through the page's approver first.
const LKEY = 'g00b_pocket_wallet', WKEY = 'g00b_pocket_words';
const utf8 = (t) => new TextEncoder().encode(t);
async function hmac512(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// 12 words: 128 random bits and a 4 bit checksum, 11 bits a word
async function newWords() {
  const list = (await import('./pocket-words.js')).default;
  if (list.length !== 2048) throw new Error('The word list didn’t load. Try again.');
  const ent = crypto.getRandomValues(new Uint8Array(16));
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', ent))[0];
  let bits = '';
  for (const b of ent) bits += b.toString(2).padStart(8, '0');
  bits += sum.toString(2).padStart(8, '0').slice(0, 4);
  const words = [];
  for (let i = 0; i < 12; i++) words.push(list[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
  return words.join(' ');
}
// words -> the wallet's 64 byte key, as Phantom derives its first account
export async function keyFromWords(words) {
  const base = await crypto.subtle.importKey('raw', utf8(String(words).normalize('NFKD')), 'PBKDF2', false, ['deriveBits']);
  const seed = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: utf8('mnemonic'), iterations: 2048, hash: 'SHA-512' }, base, 512));
  let I = await hmac512(utf8('ed25519 seed'), seed);
  for (const i of [44, 501, 0, 0]) {
    const d = new Uint8Array(37); d.set(I.subarray(0, 32), 1);
    new DataView(d.buffer).setUint32(33, (i | 0x80000000) >>> 0);
    I = await hmac512(I.subarray(32), d);
  }
  const p8 = new Uint8Array(48); p8.set(P8); p8.set(I.subarray(0, 32), 16);
  const priv = await crypto.subtle.importKey('pkcs8', p8, { name: 'Ed25519' }, true, ['sign']);
  const x = (await crypto.subtle.exportKey('jwk', priv)).x;
  const pub = Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const key = new Uint8Array(64); key.set(I.subarray(0, 32)); key.set(pub, 32);
  return key;
}
export const LOCAL_ID = 'pocket';
export const LOCAL_NAME = 'Pocket wallet';
const P8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);   // PKCS8 wrapper for an Ed25519 seed
function readLocal() {
  try {
    const raw = localStorage.getItem(LKEY);
    if (!raw) return null;
    const key = b58decode(raw);
    return key.length === 64 ? key : null;
  } catch { return null; }
}
export function localWallet() { const k = readLocal(); return k ? { address: b58encode(k.subarray(32)) } : null; }
export function localSecret() { const k = readLocal(); return k ? b58encode(k) : null; }
export function localWords() { try { return readLocal() ? localStorage.getItem(WKEY) : null; } catch { return null; } }
export async function createLocalWallet() {
  if (readLocal()) throw new Error('This browser already has a pocket wallet.');
  let words, key;
  try { words = await newWords(); key = await keyFromWords(words); }
  catch (e) { throw new Error(/word list/.test(String(e && e.message)) ? e.message : 'This browser can’t make a wallet. Update it, or use Phantom, Solflare or Backpack.'); }
  // signs and checks once before it is kept, so a broken browser never stores a key it can't use
  const probe = utf8('laundry');
  const pubKey = await crypto.subtle.importKey('raw', key.subarray(32), { name: 'Ed25519' }, false, ['verify']);
  if (!(await crypto.subtle.verify({ name: 'Ed25519' }, pubKey, await localSignWith(key, probe), probe))) throw new Error('This browser couldn’t make a working wallet.');
  localStorage.setItem(WKEY, words);
  localStorage.setItem(LKEY, b58encode(key));
  if (readLocal() === null || localStorage.getItem(WKEY) !== words) throw new Error('This browser won’t keep a wallet. Check that it isn’t in private mode.');
  return { address: b58encode(key.subarray(32)) };
}
export function forgetLocalWallet() {
  const s = session();
  if (s && s.wallet === LOCAL_NAME) signOut();
  try { localStorage.removeItem(LKEY); localStorage.removeItem(WKEY); } catch {}
}
async function localSignWith(key, bytes) {
  const p8 = new Uint8Array(48); p8.set(P8); p8.set(key.subarray(0, 32), 16);
  const k = await crypto.subtle.importKey('pkcs8', p8, { name: 'Ed25519' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, k, bytes));
}
async function localSign(bytes) {
  const key = readLocal();
  if (!key) throw new Error('The pocket wallet isn’t in this browser anymore.');
  return localSignWith(key, bytes);
}
// The page shows what a transaction does and asks first; without an approver nothing is signed.
let approver = null;
export function setLocalApprover(fn) { approver = fn; }
// Signs a transaction (legacy or v0, as wire bytes) as the pocket wallet: finds
// its signer slot and fills only that one, leaving any other signatures alone.
const shortLen = (b, o) => { let len = 0, size = 0; for (;;) { const e = b[o + size]; len |= (e & 0x7f) << (size * 7); size++; if (!(e & 0x80)) break; } return [len, size]; };
async function localSignTx(bytes) {
  const key = readLocal();
  if (!key) throw new Error('The pocket wallet isn’t in this browser anymore.');
  const tx = new Uint8Array(bytes);
  const [nsig, sz] = shortLen(tx, 0);
  const msg = tx.subarray(sz + 64 * nsig);
  let o = msg[0] & 0x80 ? 1 : 0;
  const signers = msg[o]; o += 3;
  const [, ks] = shortLen(msg, o); o += ks;
  const pub = key.subarray(32);
  let slot = -1;
  for (let i = 0; i < Math.min(signers, nsig); i++) { const k = msg.subarray(o + 32 * i, o + 32 * i + 32); if (k.every((b, j) => b === pub[j])) { slot = i; break; } }
  if (slot < 0) throw new Error('That isn’t for your pocket wallet.');
  if (!approver || !(await approver())) throw new Error('Cancelled. Nothing moved.');
  const sig = await localSignWith(key, msg);
  const out = tx.slice(); out.set(sig, sz + 64 * slot);
  return out;
}
const localProvider = () => {
  const w = localWallet();
  return w && { id: LOCAL_ID, name: LOCAL_NAME, icon: null, async connect() { return w.address; }, sign: (bytes) => localSign(bytes) };
};

// ---------- Wallet Standard ----------
// The discovery handshake from @wallet-standard/app, written out so the page
// needs no bundle. Wallets that loaded first answer the app-ready event, and
// wallets that load later announce themselves with register-wallet.
const standard = [];
const watchers = new Set();
const notify = () => watchers.forEach((fn) => { try { fn(); } catch {} });
const isSolana = (w) => Boolean(w && w.features && w.features['standard:connect'] && w.features['solana:signMessage']
  && (w.chains || []).some((c) => String(c).startsWith('solana:')));
const registry = Object.freeze({
  register(...ws) {
    const added = ws.filter((w) => isSolana(w) && !standard.includes(w));
    if (added.length) { standard.push(...added); notify(); }
    return () => {
      let gone = false;
      for (const w of added) { const i = standard.indexOf(w); if (i >= 0) { standard.splice(i, 1); gone = true; } }
      if (gone) notify();
    };
  },
  get: () => standard.slice(),
  on: () => () => {},
});
try {
  window.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(registry); } catch {} });
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registry }));
} catch {}

// Called whenever a wallet shows up or goes away, so the page can repaint.
export function onWallets(fn) { watchers.add(fn); return () => watchers.delete(fn); }

// ---------- one shape for both kinds ----------
const adapters = new WeakMap();
function fromStandard(w) {
  if (adapters.has(w)) return adapters.get(w);
  let account = null;
  const a = {
    id: 'std:' + w.name,
    name: String(w.name || 'Wallet'),
    // The standard requires a data URI; anything else is not shown.
    icon: typeof w.icon === 'string' && w.icon.startsWith('data:image/') ? w.icon : null,
    async connect() {
      const res = await w.features['standard:connect'].connect();
      const list = (res && res.accounts && res.accounts.length) ? res.accounts : (w.accounts || []);
      account = list.find((x) => (x.chains || []).some((c) => String(c).startsWith('solana:'))) || list[0] || null;
      if (!account) throw new Error('Wallet did not return an address');
      return account.address;
    },
    async sign(bytes) {
      const [out] = await w.features['solana:signMessage'].signMessage({ account, message: bytes });
      return out.signature;
    },
  };
  adapters.set(w, a);
  return a;
}
function fromInjected(id, name, api) {
  return {
    id, name, icon: null,
    async connect() {
      const resp = await api.connect();
      return String((resp && resp.publicKey) || api.publicKey || '');
    },
    async sign(bytes) {
      const signed = await api.signMessage(bytes, 'utf8');
      return signed.signature || signed;
    },
  };
}

// Every wallet this browser has, each listed once. A wallet that registers
// through the standard and also injects a global shows up by its standard entry.
export function providers() {
  const list = standard.map(fromStandard);
  const have = new Set(list.map((w) => w.name.toLowerCase()));
  const add = (id, name, api) => {
    if (!api || have.has(name.toLowerCase())) return;
    list.push(fromInjected(id, name, api)); have.add(name.toLowerCase());
  };
  const p = window.phantom && window.phantom.solana;
  if (p && p.isPhantom) add('phantom', 'Phantom', p);
  else if (window.solana && window.solana.isPhantom) add('phantom', 'Phantom', window.solana);
  if (window.solflare && window.solflare.isSolflare) add('solflare', 'Solflare', window.solflare);
  if (window.backpack && window.backpack.solana) add('backpack', 'Backpack', window.backpack.solana);
  if (!list.length && window.solana) add('injected', 'Wallet', window.solana);
  return list;
}

// ---------- the wallets people ask for by name ----------
// These show in the picker whether or not this browser has them. A phone has
// no extensions, so there the button opens this page inside the wallet's own
// app, where it can sign. On a computer it goes to the install page.
const browse = (base) => (u) => base + encodeURIComponent(u) + '?ref=' + encodeURIComponent(location.origin);
// `match` finds the wallet among installed ones, whose names vary a little
// ("Trust" or "Trust Wallet").
export const CATALOG = [
  { name: 'Phantom',  match: /phantom/i,  icon: '/wallets/phantom.svg',  install: 'https://phantom.com/download',  open: browse('https://phantom.app/ul/browse/') },
  { name: 'Solflare', match: /solflare/i, icon: '/wallets/solflare.svg', install: 'https://solflare.com/download', open: browse('https://solflare.com/ul/v1/browse/') },
  { name: 'Backpack', match: /backpack/i, icon: '/wallets/backpack.png', install: 'https://backpack.app/download', open: browse('https://backpack.app/ul/v1/browse/') },
  { name: 'Coinbase', match: /coinbase/i, icon: '/wallets/coinbase.svg', install: 'https://www.coinbase.com/wallet/downloads',
    open: (u) => 'https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent(u) },
  // 501 is Solana's coin number, so the page opens on the Solana network
  { name: 'Trust Wallet', match: /trust/i, icon: '/wallets/trust.png', install: 'https://trustwallet.com/download',
    open: (u) => 'https://link.trustwallet.com/open_url?coin_id=501&url=' + encodeURIComponent(u) },
  { name: 'OKX Wallet', match: /okx/i, icon: '/wallets/okx.png', install: 'https://web3.okx.com/download',
    open: (u) => 'https://web3.okx.com/download?deeplink=' + encodeURIComponent('okx://wallet/dapp/url?dappUrl=' + encodeURIComponent(u)) },
  // pump.fun keeps its wallet inside pump.fun, behind an email or social login,
  // so there is nothing another site can connect to. The picker says how to
  // bring the coins over rather than offering a button that cannot work.
  { name: 'pump.fun', match: /pump\.?fun/i, icon: '/wallets/pump.png',
    note: 'A pump.fun wallet can\u2019t connect to other sites. Send your coins to Phantom, Solflare or Backpack, then connect that one.' },
];
export const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
export const iconFor = (name) => (CATALOG.find((c) => c.match.test(String(name))) || {}).icon || null;

// What the picker lists: the wallets this browser has, then the named ones it doesn't.
export function choices() {
  const have = providers();
  return { have, missing: CATALOG.filter((c) => !have.some((w) => c.match.test(w.name))) };
}

export function session() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return (s && s.exp > Date.now()) ? s : (localStorage.removeItem(KEY), null);
  } catch { return null; }
}

export function signOut() { try { localStorage.removeItem(KEY); } catch {} }

export async function connect(pref) {
  const local = pref === LOCAL_ID ? localProvider() : null;
  if (pref === LOCAL_ID && !local) throw new Error('There’s no pocket wallet in this browser.');
  const found = local ? [local] : providers();
  if (!found.length) throw new Error(NO_WALLET);
  const w = (pref && found.find((f) => f.id === pref)) || found[0];

  const owner = await w.connect();
  if (!owner) throw new Error('Wallet did not return an address');

  const n = await fetch('/api/auth?q=nonce&owner=' + encodeURIComponent(owner)).then((r) => r.json());
  if (n.error) throw new Error(n.error);

  const sig = await w.sign(new TextEncoder().encode(n.message));
  const signature = b58encode(sig instanceof Uint8Array ? sig : new Uint8Array(sig));

  const v = await fetch('/api/auth?q=verify', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner, nonce: n.nonce, issued: n.issued, signature }),
  }).then((r) => r.json());
  if (v.error) throw new Error(v.error);

  const s = { owner: v.owner, session: v.session, exp: v.exp, wallet: w.name };
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  return s;
}

export const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');

// ---------- approving a transaction ----------
// Hands a transaction to the signed-in wallet. The wallet shows the player what
// it does, and nothing is sent unless they approve it there. After a reload the
// page has lost the wallet's connection, so it reconnects quietly first (the
// wallet only asks again if it has to).
const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
// The signed-in wallet and its account, ready to approve something.
async function walletAccount() {
  const s = session();
  if (!s) throw new Error('Connect your wallet first');
  const w = standard.find((x) => x.name === s.wallet) || standard.find((x) => (x.accounts || []).some((a) => a.address === s.owner));
  if (!w) throw new Error('Open this page in ' + (s.wallet || 'the wallet you signed in with') + ' to approve it.');
  const mine = (list) => (list || []).find((a) => a.address === s.owner);
  let account = mine(w.accounts);
  if (!account) { try { account = mine((await w.features['standard:connect'].connect({ silent: true })).accounts); } catch {} }
  if (!account) account = mine((await w.features['standard:connect'].connect()).accounts);
  if (!account) throw new Error('Switch your wallet to ' + short(s.owner) + ' and try again.');
  return { w, account };
}
// Sign only, never send: for a transaction that someone else sends (a keeper
// that adds its own signature, or a close kept for a later day).
const isLocal = () => { const s = session(), l = localWallet(); return Boolean(s && s.wallet === LOCAL_NAME && l && l.address === s.owner); };
export async function signOnly(bytes) {
  if (isLocal()) return b64(await localSignTx(bytes));
  const { w, account } = await walletAccount();
  if (!w.features['solana:signTransaction']) throw new Error('This wallet can’t sign without sending. Try Phantom, Solflare or Backpack.');
  const [out] = await w.features['solana:signTransaction'].signTransaction({ account, transaction: bytes, chain: 'solana:mainnet' });
  return b64(out.signedTransaction);
}
export async function approveTx(bytes) {
  if (isLocal()) return { signed: b64(await localSignTx(bytes)) };
  const { w, account } = await walletAccount();
  const chain = 'solana:mainnet';
  if (w.features['solana:signAndSendTransaction']) {
    const [out] = await w.features['solana:signAndSendTransaction'].signAndSendTransaction({ account, transaction: bytes, chain, options: { commitment: 'confirmed' } });
    return { signature: b58encode(out.signature) };
  }
  if (w.features['solana:signTransaction']) {
    const [out] = await w.features['solana:signTransaction'].signTransaction({ account, transaction: bytes, chain });
    return { signed: b64(out.signedTransaction) };
  }
  throw new Error('This wallet can’t approve this here. Try Phantom, Solflare or Backpack.');
}
