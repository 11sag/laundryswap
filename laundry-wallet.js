// Wallet sign-in for Laundry Swap: the wallet list, connecting, and telling the
// page when the signed-in wallet changes. Signing in only signs a sentence and
// never moves funds. The one thing that can move funds is approveTx, and only
// through the wallet's own approval screen. The wallet plumbing is in wallet.js.
import { connect, session, signOut, short, onWallets, choices, isPhone, iconFor, approveTx } from './wallet.js';

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
  if (s) {
    st.textContent = 'Signed in as ' + short(s.owner) + ' via ' + (s.wallet || 'wallet') + '.';
    b.textContent = 'Disconnect';
  } else {
    if ($('wpick') && !$('wpick').hidden) return;   // the picker's prompt stays up
    st.textContent = 'Connect a wallet to prove it is yours. Nothing moves and it costs nothing.';
    b.textContent = 'Connect wallet';
  }
}

export { session, short, approveTx };
