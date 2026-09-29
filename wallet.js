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
  const found = providers();
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
export async function approveTx(bytes) {
  const s = session();
  if (!s) throw new Error('Connect your wallet first');
  const w = standard.find((x) => x.name === s.wallet) || standard.find((x) => (x.accounts || []).some((a) => a.address === s.owner));
  if (!w) throw new Error('Open this page in ' + (s.wallet || 'the wallet you signed in with') + ' to approve swaps.');
  const mine = (list) => (list || []).find((a) => a.address === s.owner);
  let account = mine(w.accounts);
  if (!account) { try { account = mine((await w.features['standard:connect'].connect({ silent: true })).accounts); } catch {} }
  if (!account) account = mine((await w.features['standard:connect'].connect()).accounts);
  if (!account) throw new Error('Switch your wallet to ' + short(s.owner) + ' and try again.');
  const chain = 'solana:mainnet';
  if (w.features['solana:signAndSendTransaction']) {
    const [out] = await w.features['solana:signAndSendTransaction'].signAndSendTransaction({ account, transaction: bytes, chain, options: { commitment: 'confirmed' } });
    return { signature: b58encode(out.signature) };
  }
  if (w.features['solana:signTransaction']) {
    const [out] = await w.features['solana:signTransaction'].signTransaction({ account, transaction: bytes, chain });
    return { signed: b64(out.signedTransaction) };
  }
  throw new Error('This wallet cannot approve swaps here. Try Phantom, Solflare or Backpack.');
}
