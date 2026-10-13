// Wallet sign-in for Laundry Swap: the wallet list, connecting, and telling the
// page when the signed-in wallet changes. Signing in only signs a sentence and
// never moves funds. The one thing that can move funds is approveTx, and only
// through the wallet's own approval screen. The wallet plumbing is in wallet.js.
import { connect, session, signOut, short, onWallets, choices, isPhone, iconFor, approveTx, signOnly,
  LOCAL_ID, LOCAL_NAME, localWallet, localSecret, createLocalWallet, forgetLocalWallet, setLocalApprover } from './wallet.js';

const $ = (id) => document.getElementById(id);
const told = (detail) => { try { window.dispatchEvent(new CustomEvent('laundry:wallet', { detail })); } catch {} };

export async function walletConnect(pref) {
  const st = $('wstate');
  if (session()) { signOut(); paintWallet(); told({ signedIn: false }); return; }
  // Nothing picked yet: show every wallet the site supports, so the sign-in
  // never pops up in a wallet the player did not mean to use.
  if (!pref) {
    paintPicker();
    if (st) st.textContent = 'Pick the wallet to sign in with.';
    return;
  }
  hidePicker();
  try {
    if (st) st.textContent = 'Check your wallet to sign in…';
    await connect(pref);
    paintWallet();
    told({ signedIn: true });
  } catch (e) {
    const msg = e.message || 'Could not connect.';
    if (st) st.textContent = msg;
    told({ error: msg });
  }
}

// Installed wallets sign in here. The named ones this browser lacks open the
// wallet's app on a phone or its install page on a computer, and pump.fun
// explains itself, since its wallet cannot connect anywhere but pump.fun.
function paintPicker() {
  const box = $('wpick'); if (!box) return;
  const { have, missing } = choices();
  const phone = isPhone();
  box.innerHTML = '';
  const row = (tag, name, icon, label) => {
    const el = document.createElement(tag);
    el.className = 'wrow';
    if (tag === 'button') el.type = 'button';
    if (icon) { const i = document.createElement('img'); i.src = icon; i.alt = ''; i.width = 20; i.height = 20; el.appendChild(i); }
    const n = document.createElement('span'); n.className = 'wname'; n.textContent = name; el.appendChild(n);
    if (label) { const t = document.createElement('small'); t.className = 'wtag'; t.textContent = label; el.appendChild(t); }
    box.appendChild(el);
    return el;
  };
  const lw = localWallet();
  if (lw) row('button', LOCAL_NAME, '/pocket-wallet.svg', short(lw.address)).addEventListener('click', () => walletConnect(LOCAL_ID));
  for (const w of have) row('button', w.name, w.icon || iconFor(w.name)).addEventListener('click', () => walletConnect(w.id));
  for (const c of missing) {
    if (c.note) {
      const b = row('button', c.name, c.icon);
      const p = document.createElement('p'); p.className = 'wnote'; p.textContent = c.note; p.hidden = true;
      b.setAttribute('aria-expanded', 'false');
      b.addEventListener('click', () => { p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); });
      box.appendChild(p);
      continue;
    }
    const a = row('a', c.name, c.icon, phone ? 'Open' : 'Install');
    a.href = phone ? c.open(window.laundryCarryUrl ? window.laundryCarryUrl() : location.href) : c.install;
    if (!phone) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  }
  box.hidden = false;
}
function hidePicker() { const box = $('wpick'); if (box) { box.hidden = true; box.innerHTML = ''; } }

// A wallet can announce itself after the page has painted. Repaint when it
// does, and keep an open picker in step with what is actually installed.
onWallets(() => {
  paintWallet();
  const box = $('wpick');
  if (box && !box.hidden && !session()) paintPicker();
});

export function paintWallet() {
  const st = $('wstate'), b = $('wbtn');
  if (!st || !b) return;
  const s = session();
  if ($('wnew')) $('wnew').hidden = Boolean(s || localWallet());
  paintLocal();
  if (s) {
    st.textContent = 'Signed in as ' + short(s.owner) + ' via ' + (s.wallet || 'wallet') + '.';
    b.textContent = 'Disconnect';
  } else {
    if ($('wpick') && !$('wpick').hidden) return;   // the picker's prompt stays up
    st.textContent = 'Connect a wallet to prove it is yours. Nothing moves and it costs nothing.';
    b.textContent = 'Connect wallet';
  }
}

// ---------- the pocket wallet ----------
// Made in this browser, so laundry money can stay apart from a main wallet. The
// key never leaves the browser: the site only ever sees signatures. Right after
// it's made, the secret key shows once with a backup step; it can be shown again
// from the menu while signed in with it.
const LSTATE = { backup: false, key: false, remove: false, busy: false, note: '' };
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); const was = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = was; }, 1500); } catch {}
}
export async function createWallet() {
  const st = $('wstate');
  try {
    await createLocalWallet();
    LSTATE.backup = true; hidePicker();
    paintWallet();
    if (st) { st.textContent = ''; st.hidden = true; }
  } catch (e) { if (st) { st.textContent = e.message; st.hidden = false; } }
}
const usingLocal = () => { const s = session(), l = localWallet(); return Boolean(s && l && s.wallet === LOCAL_NAME && s.owner === l.address); };
function paintLocal() {
  const box = $('lwal'); if (!box) return;
  const lw = localWallet();
  // just made: the backup step, before anything else
  if (lw && LSTATE.backup) {
    box.innerHTML = '<b class="lhead">Save your secret key</b>'
      + '<p>This is the only way to open this wallet anywhere else. Anyone who has it can take what’s inside. We never see it and can’t get it back for you.</p>'
      + '<code class="lkey">' + esc(localSecret()) + '</code>'
      + '<button type="button" class="lbtn" id="lcopykey">Copy key</button>'
      + '<p class="lsmall">Paste it somewhere safe, like a password manager. Phantom, Solflare and Backpack can open it with “Import private key”.</p>'
      + '<button type="button" class="lbtn dark" id="lsaved">I saved it</button>';
    box.hidden = false;
    $('lcopykey').addEventListener('click', (e) => copy(localSecret(), e.currentTarget));
    $('lsaved').addEventListener('click', async () => { LSTATE.backup = false; await walletConnect(LOCAL_ID); });
    return;
  }
  if (!usingLocal()) { box.hidden = true; box.innerHTML = ''; return; }
  let h = '<b class="lhead">Your pocket wallet</b>'
    + '<code class="laddr">' + esc(lw.address) + '</code>'
    + '<button type="button" class="lbtn" id="lcopyaddr">Copy address</button>'
    + '<p class="lsmall">Send SOL to this address to fill it. Keep only laundry money here, not savings.</p>';
  h += '<input class="lto" id="lto" placeholder="Your main wallet address" autocomplete="off" spellcheck="false" aria-label="Wallet to send everything to">'
    + '<button type="button" class="lbtn dark" id="lsend"' + (LSTATE.busy ? ' disabled' : '') + '>Send everything</button>'
    + '<p class="lsmall">Take things out of the dryer first. Stakes, loans and boosts stay put.</p>'
    + '<p class="lnote" id="lnote"' + (LSTATE.note ? '' : ' hidden') + '>' + esc(LSTATE.note) + '</p>';
  h += LSTATE.key
    ? '<p class="lsub">Secret key</p><code class="lkey">' + esc(localSecret()) + '</code><button type="button" class="lbtn" id="lcopykey">Copy key</button><button type="button" class="lbtn" id="lhidekey">Hide key</button>'
    : '<button type="button" class="lbtn" id="lshowkey">Show secret key</button>';
  h += LSTATE.remove
    ? '<p class="lsmall warn">Remove it from this browser? Only do this if it’s empty or you saved the key. Without the key, what’s inside is gone for good.</p>'
      + '<button type="button" class="lbtn warn" id="lremoveyes">Yes, remove it</button><button type="button" class="lbtn" id="lremoveno">Keep it</button>'
    : '<button type="button" class="lbtn" id="lremove">Remove from this browser</button>';
  const keep = $('lto') ? $('lto').value : '';
  box.innerHTML = h; box.hidden = false;
  $('lto').value = keep;
  $('lcopyaddr').addEventListener('click', (e) => copy(lw.address, e.currentTarget));
  $('lsend').addEventListener('click', () => sendEverything($('lto').value));
  if ($('lshowkey')) $('lshowkey').addEventListener('click', () => { LSTATE.key = true; paintLocal(); });
  if ($('lhidekey')) $('lhidekey').addEventListener('click', () => { LSTATE.key = false; paintLocal(); });
  if ($('lcopykey')) $('lcopykey').addEventListener('click', (e) => copy(localSecret(), e.currentTarget));
  if ($('lremove')) $('lremove').addEventListener('click', () => { LSTATE.remove = true; paintLocal(); });
  if ($('lremoveno')) $('lremoveno').addEventListener('click', () => { LSTATE.remove = false; paintLocal(); });
  if ($('lremoveyes')) $('lremoveyes').addEventListener('click', () => {
    LSTATE.remove = false; LSTATE.key = false; forgetLocalWallet(); paintWallet(); told({ signedIn: false });
  });
}
const lnote = (t) => { LSTATE.note = t; const n = $('lnote'); if (n) { n.textContent = t; n.hidden = !t; } };
const lpost = async (body) => {
  const s = session();
  const r = await fetch('/api/dryer?q=build', { method: 'POST', headers: { 'content-type': 'application/json', ...(s ? { authorization: 'Bearer ' + s.session } : {}) }, body: JSON.stringify(body) });
  return r.json();
};
const pause = (ms) => new Promise((res) => setTimeout(res, ms));
const toB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
async function landed(sig, until) {
  for (let i = 0; i < 40; i++) {
    await pause(i ? 1500 : 800);
    const r = await fetch('/api/dryer?q=status&sig=' + encodeURIComponent(sig) + '&until=' + until).then((x) => x.json()).catch(() => ({}));
    if (r.status === 'failed' || r.status === 'expired') return false;
    if (r.status === 'confirmed' || r.status === 'finalized') return true;
  }
  return null;
}
// Coins go a few at a time, then the SOL. Each step is approved on its own.
async function sendEverything(to) {
  if (LSTATE.busy || !usingLocal()) return;
  to = String(to || '').trim();
  if (!to) return lnote('Paste your main wallet address first.');
  LSTATE.busy = true; $('lsend').disabled = true;
  let sent = false;
  try {
    for (let step = 0; step < 8; step++) {
      lnote('Checking it with the network…');
      const r = await lpost({ op: 'sendall', to });
      if (r.done && sent) { lnote('All sent.'); break; }
      if (!r.tx) throw new Error(r.error || 'Something went wrong. Try again.');
      lnote(r.more ? 'Approve it. It sends ' + (r.coinsLeft > r.coins ? r.coins + ' of your ' + r.coinsLeft + ' coins' : 'your coins') + ' to ' + short(to) + '. The SOL goes last.' : 'Approve it: it sends all your SOL, about ' + r.sol + ', to ' + short(to) + '.');
      const { signed } = await approveTx(toB64(r.tx));
      const s = await fetch('/api/dryer?q=send', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session().session }, body: JSON.stringify({ signed }) }).then((x) => x.json());
      if (s.error) throw new Error(s.error);
      lnote('Sent. Waiting for the network…');
      const ok = await landed(s.signature, r.until);
      if (ok === false) throw new Error('That didn’t go through. Nothing moved. Try again.');
      sent = true;
      if (!r.more) { lnote('All sent to ' + short(to) + '.'); break; }
      await pause(1500);
    }
  } catch (e) { lnote((e && e.message) || 'Something went wrong. Try again.'); }
  finally { LSTATE.busy = false; if ($('lsend')) $('lsend').disabled = false; told({ refresh: true }); }
}
// The pocket wallet has no approval screen of its own, so the page asks: what
// the transaction does (the page's own note, said just before), then Approve.
setLocalApprover(() => new Promise((done) => {
  const what = ['lnote', 'dnote', 'note'].map((id) => $(id)).find((n) => n && !n.hidden && /approve/i.test(n.textContent || ''));
  const card = document.createElement('div');
  card.className = 'lapprove'; card.id = 'lapprove'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', 'Approve with your pocket wallet');
  card.innerHTML = '<div class="lcard"><b>Approve with your pocket wallet?</b><p>' + esc(what ? what.textContent.replace(/^Approve it( in your wallet)?[.:]\s*/i, '') : 'This sends a transaction from your pocket wallet.') + '</p>'
    + '<div class="lrow"><button type="button" class="lbtn" id="lno">Cancel</button><button type="button" class="lbtn dark" id="lyes">Approve</button></div></div>';
  document.body.appendChild(card);
  const finish = (yes) => { card.remove(); document.removeEventListener('keydown', key); done(yes); };
  const key = (e) => { if (e.key === 'Escape') finish(false); };
  document.addEventListener('keydown', key);
  card.querySelector('#lyes').addEventListener('click', () => finish(true));
  card.querySelector('#lno').addEventListener('click', () => finish(false));
  card.querySelector('#lyes').focus();
}));

paintWallet();

export { session, short, approveTx, signOnly };
