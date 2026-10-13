// Tests for the dryer that need no network: its rules (dryer-core.js) and the
// server's checks that come before any Solana call. The transactions themselves
// are tried against mainnet by tools-dryer-sim.mjs.
// Run: node tools-dryer-test.mjs
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { DIAL, BORROW_COINS, BOOST_COINS, BORROW_CAP, LEVERAGE, FEE_PCT, FEE_WALLET, feeLamports, liqPrice, riskOf, borrowRoom } from './dryer-core.js';

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };
const near = (a, b, what) => ok(Math.abs(a - b) < 1e-9, what + ` (${a} vs ${b})`);

// ---- the rules ----
ok(DIAL.map((d) => d.key).join() === 'stake,borrow,boost', 'three dial settings, in order');
ok(LEVERAGE === 1.5, 'the boost is 1.5x');
ok(BORROW_CAP === 0.6, 'borrowing stops at 60% of what Kamino would lend');
ok(BOOST_COINS.every((c) => BORROW_COINS.some((b) => b.sym === c.sym)), 'every boost coin can also be borrowed against');
ok(!BORROW_COINS.some((c) => /BONK|WIF|FART|POPCAT|TRUMP/i.test(c.sym)), 'no memecoins: Kamino does not lend against them');
near(liqPrice(10, 400, 0.8), 50, 'sells when 10 coins x 0.8 cover $400 owed: at $50');
ok(liqPrice(0, 400, 0.8) === null && liqPrice(10, 400, 0) === null, 'no price without a coin or a threshold');
near(riskOf(1000, 0, 0.8), 0, 'no debt is no risk');
near(riskOf(1000, 400, 0.8), 0.5, '$400 owed on $800 of selling room is halfway');
near(riskOf(1000, 2000, 0.8), 1, 'risk never goes past 1');
ok(riskOf(0, 10, 0.8) === 1, 'debt with nothing in is all the way');
near(borrowRoom(1000, 0.74, 0), 444, '$1,000 of SOL (74% max) lends up to $444 here');
near(borrowRoom(1000, 0.74, 400), 44, 'what is already owed comes off');
near(borrowRoom(1000, 0.74, 500), 0, 'never below zero');
// ---- Laundry Swap's fee ----
ok(FEE_PCT === 0.25, 'the fee is 0.25%');
ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(FEE_WALLET), 'the fee wallet is a Solana address');
ok(feeLamports(10, 1) === 25_000_000, 'staking 10 SOL: a 0.025 SOL fee');
ok(feeLamports(1000, 200) === 12_500_000, 'borrowing $1,000 with SOL at $200: $2.50, 0.0125 SOL');
ok(feeLamports(0, 200) === 0 && feeLamports(100, 0) === 0 && feeLamports(100, 200, 0) === 0, 'no amount, no price or a 0% rate: no fee');
ok(feeLamports(1, 1, 1) === 10_000_000, 'the rate can be set (1% of 1 SOL)');
// a full borrow at the cap stays well short of selling: 0.6 x 0.74 / 0.8 = 55.5% of the way
ok(riskOf(1000, borrowRoom(1000, 0.74, 0), 0.8) < 0.6, 'a borrow at the cap is under 60% of the way to selling');

// ---- the server's checks (no network) ----
process.env.AUTH_SECRET = 'test-secret';
process.env.SOLANA_NETWORK = 'devnet';
const { default: handler } = await import('./api/dryer.js');
const token = (owner, exp = Date.now() + 3600e3) => { const p = Buffer.from(JSON.stringify({ owner, exp })).toString('base64url'); return p + '.' + crypto.createHmac('sha256', 'test-secret').update('s:' + p).digest('base64url'); };
const call = (q, { owner, body, method, extra = {}, auth } = {}) => new Promise((done) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(j) { done({ code: this.code, j }); } };
  handler({ method: method || (body ? 'POST' : 'GET'), query: { q, ...extra }, headers: auth != null ? { authorization: auth } : owner ? { authorization: 'Bearer ' + token(owner) } : {}, body: body || {} }, res);
});
let r = await call('info');
ok(r.code === 200 && r.j.on === false, 'off the mainnet the dryer stays hidden');
process.env.DRYER_ANY_NETWORK = '1';
const me = Keypair.generate().publicKey.toBase58();
r = await call('mine'); ok(r.code === 401, 'no session, no positions');
r = await call('mine', { auth: 'Bearer ' + token(me, Date.now() - 1000) }); ok(r.code === 401, 'an expired session is refused');
r = await call('mine', { auth: 'Bearer ' + token(me).replace(/.$/, 'x') }); ok(r.code === 401, 'a session with a bad signature is refused');
r = await call('build', { owner: me, method: 'GET' }); ok(r.code === 405, 'build is POST only');
r = await call('build', { owner: me, body: { op: 'sweep' } }); ok(r.code === 400 && r.j.error === 'Unknown', 'an unknown setting is refused');
r = await call('status', { extra: { sig: 'not-a-signature' } }); ok(r.code === 400, 'a bad signature is refused before asking the network');
r = await call('send', { owner: me, body: { signed: 'bm90IGEgdHg=' } }); ok(r.code === 400, 'garbage is not sent');
const other = Keypair.generate();
const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: other.publicKey, lamports: 1 }));
tx.feePayer = other.publicKey; tx.recentBlockhash = '11111111111111111111111111111111'; tx.sign(other);
r = await call('send', { owner: me, body: { signed: tx.serialize().toString('base64') } }); ok(r.code === 400 && /this wallet/.test(r.j.error), 'a transaction paid by another wallet is never sent');
// twenty builds a minute per wallet, then a pause
let last; for (let i = 0; i < 21; i++) last = await call('build', { owner: me, body: { op: 'sweep' } });
ok(last.code === 429, 'a wallet asking too fast is told to slow down');
console.log(`dryer: ${n} checks passed`);
process.exit(0);
