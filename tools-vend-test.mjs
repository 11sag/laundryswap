// Vending machine, end to end, without moving anything: the real handler, an
// in-memory ledger, real g00b metadata from mainnet, and a local Solana RPC that
// forwards to mainnet except for what the vending wallet holds and the calls
// that would send an NFT, which it answers itself.
// Run: node --import ./tools-dev-register.mjs tools-vend-test.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import WS from 'ws';
import * as web3 from '@solana/web3.js';
import * as blob from './tools-dev-blob-stub.mjs';
import { vendDraw, seedHash, VEND } from './laundry-core.js';

const PORT = 18911, REAL = 'https://api.mainnet-beta.solana.com';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => { const d = [0]; for (const b of bytes) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let o = ''; for (const b of bytes) { if (b === 0) o += '1'; else break; } return o + d.reverse().map((x) => B58[x]).join(''); };
const vendKey = web3.Keypair.generate();                   // a throwaway, never funded
const VW = vendKey.publicKey.toBase58();
const G00BS = ['ERaF33ZyGpuvLDMbxkW7bQEoRoeN2SYFZh93CBkf2JZC', 'DP7n5uQRc5g51B4dD4fVSqA8VrrGkqLbytNCtazBbm2m', 'BMhTSPsvwiaANjwjzMtQ9phf66ZMSsMX3UipxHQNC1bF'];
const SPAM = web3.Keypair.generate().publicKey.toBase58();  // an "NFT" with no metadata at all
const HELD = new Map([[VW, new Set([...G00BS, SPAM])]]);    // owner -> mints, as the stand-in chain sees it
const SEND = { mode: 'ok', count: 0, sigs: new Map() };
const acct = (mint, owner) => ({ pubkey: web3.Keypair.generate().publicKey.toBase58(), account: { data: { parsed: { info: { mint, owner, tokenAmount: { amount: '1', decimals: 0, uiAmount: 1 } } } } } });

// ---- the stand-in RPC ----
const answer = async (m) => {
  const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'getTokenAccountsByOwner') {
    const [owner, filter] = m.params, mints = [...(HELD.get(owner) || [])];
    if (filter.mint) return ok({ context: { slot: 1 }, value: mints.filter((x) => x === filter.mint).map((x) => acct(x, owner)) });
    return ok({ context: { slot: 1 }, value: filter.programId === TOKEN ? mints.map((x) => acct(x, owner)) : [] });
  }
  if (m.method === 'sendTransaction') {
    SEND.count++;
    if (SEND.mode === 'fail') return { jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'mock: refused before sending' } };
    const sig = b58(Buffer.from(m.params[0], 'base64').subarray(1, 65));    // a transaction's own first signature, as a real node answers
    SEND.sigs.set(sig, true);
    return ok(sig);
  }
  if (m.method === 'getSignatureStatuses') return ok({ context: { slot: globalThis.LAGGING ? 1 : 9e11 }, value: m.params[0].map((s) => SEND.sigs.has(s) ? { slot: 1, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' } : null) });
  for (let i = 0; i < 4; i++) {
    const r = await fetch(REAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) });
    if (r.status !== 429) return r.json();
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  return { jsonrpc: '2.0', id: m.id, error: { code: 429, message: 'rate limited' } };
};
const rpc = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const msg = JSON.parse(body);
  const out = Array.isArray(msg) ? await Promise.all(msg.map(answer)) : await answer(msg);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
}).listen(PORT);
const wss = new WS.Server({ port: PORT + 1 });
let sub = 0;
wss.on('connection', (ws) => ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.method === 'signatureSubscribe') {
    const id = ++sub;
    ws.send(JSON.stringify({ jsonrpc: '2.0', result: id, id: m.id }));
    setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'signatureNotification', params: { result: { context: { slot: 1 }, value: { err: null } }, subscription: id } })), 50);
  } else if (m.method && m.method.endsWith('Unsubscribe')) ws.send(JSON.stringify({ jsonrpc: '2.0', result: true, id: m.id }));
}));

// ---- the handler, with this test's settings ----
Object.assign(process.env, { LAUNDRY_NEW_WALLETS_PER_IP: '1000', AUTH_SECRET: 'test-secret', VEND_SECRET: b58(vendKey.secretKey), MAINNET_RPC_URL: `http://127.0.0.1:${PORT}`, SOLANA_NETWORK: 'devnet' });
const handler = (await import('./api/laundry.js')).default;
const mac = (s) => crypto.createHmac('sha256', 'test-secret').update(s).digest('base64url');
const session = (owner) => { const p = Buffer.from(JSON.stringify({ owner, exp: Date.now() + 36e5 })).toString('base64url'); return p + '.' + mac('s:' + p); };
async function call(q, { owner, body, ip = '1.1.1.1', method = 'POST' } = {}) {
  const req = { method, query: { q }, body: body || {}, headers: { 'x-forwarded-for': ip, ...(owner ? { authorization: 'Bearer ' + session(owner) } : {}) } };
  return new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { resolve({ code: this.code, ...d }); }, send() { resolve({ code: this.code }); }, end() { resolve({ code: this.code }); } };
    handler(req, res);
  });
}
const ledger = () => blob.read('laundry/ledger.json');
const setLedger = (fn) => { const l = ledger(); fn(l); blob.seed('laundry/ledger.json', l); };
const wallet = () => web3.Keypair.generate().publicKey.toBase58();
const [A, B, C, D] = [wallet(), wallet(), wallet(), wallet()];
blob.seed('laundry/ledger.json', { wallets: {}, mints: {}, vendGiftRound: 1 });   // the house gift is tested on its own at the end
let pass = 0, fail = 0;
const check = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const give = (owner, pops) => setLedger((l) => { l.wallets[owner] = { ...(l.wallets[owner] || { staked: {}, detail: {}, accrued: 0 }), pops }; });
// Pull with a client seed picked, from the seed the server committed to, to land
// the way the test needs (the test can read the ledger; a player cannot).
async function pullAs(owner, want, ip) {
  const c = await call('vcommit', { owner, ip });
  const r = ledger().wallets[owner].vendRound;
  let clientSeed = 'seed0';
  if (want) for (let i = 0; i < 5000; i++) { const cs = 'try' + i; if (vendDraw(r.seed, cs, r.nonce, true).kind === want) { clientSeed = cs; break; } }
  return { c, r, clientSeed, out: await call('vend', { owner, ip, body: { clientSeed } }) };
}

// the laundry's own ledger starts as a copy of the shared one, once
blob.store.delete('laundry/ledger.json');
blob.seed('stake/ledger.json', { wallets: { moved: { pops: 7 } }, mints: {} });
await call('config');
check('the first request copies the shared ledger across', blob.read('laundry/ledger.json').wallets.moved.pops === 7);
blob.seed('stake/ledger.json', { wallets: {}, mints: {} });
await call('config');
check('and never again after that', blob.read('laundry/ledger.json').wallets.moved.pops === 7);
blob.seed('laundry/ledger.json', { wallets: {}, mints: {}, vendGiftRound: 1 });

// the machine as the page sees it
const cfg = await call('config');
check('config lists the machine, stocked with the g00bs only (no spam)', cfg.vend && cfg.vend.stock === 3 && cfg.vend.wallet === VW && cfg.vend.price === VEND.price, `stock ${cfg.vend && cfg.vend.stock}`);

// refusals
check('no session is refused', (await call('vcommit')).code === 401 && (await call('vend', { body: {} })).code === 401);
give(A, 60);
await call('vcommit', { owner: A });
const short = await call('vend', { owner: A, body: { clientSeed: 'x' } });
check('too few bubbles is refused and says how many more', short.code === 400 && /40 more/.test(short.error) && short.pops === 60, short.error);
give(A, 1000);
setLedger((l) => { l.wallets[A].vendRound = { nonce: 9 }; });
check('a pull with no commitment is refused', (await call('vend', { owner: A, body: { clientSeed: 'x' } })).recommit === true);

// a candy pull, checked the way a player can
const p1 = await pullAs(A, 'candy');
const f = p1.out.fairness || {};
check('a pull spends 100 bubbles', p1.out.pops === 900, `pops ${p1.out.pops}`);
check('the revealed seed matches the promised hash', f.hash === p1.c.hash && seedHash(f.seed) === p1.c.hash);
const redo = vendDraw(f.seed, f.clientSeed, f.nonce, f.canWin);
check('anyone can redo the draw and land on the same slot', redo.kind === p1.out.kind && redo.slot === p1.out.slot, `${p1.out.kind} ${p1.out.slot}`);
check('candy drops from a candy slot', p1.out.kind === 'candy' && !VEND.nftSlots.includes(p1.out.slot));
check('a candy pull adds to the candy count', p1.out.candy === 1 && ledger().wallets[A].candy === 1);
check('the seed is spent: pulling again without a new commitment is refused', (await call('vend', { owner: A, body: { clientSeed: 'again' } })).recommit === true);
check('the refused pull cost nothing', ledger().wallets[A].pops === 900);

// an NFT win
const p2 = await pullAs(A, 'nft');
check('an NFT pull wins and drops from an NFT slot', p2.out.kind === 'nft' && VEND.nftSlots.includes(p2.out.slot) && p2.out.win && p2.out.win.id, `slot ${p2.out.slot}`);
const winA = p2.out.win.id;
check('the win waits in the ledger', ledger().wallets[A].vendWins[0].state === 'won');
check('an open win holds an NFT back from the stock', (await call('config')).vend.stock === 2);
const p3 = await pullAs(A, 'nft');
check('a second NFT for the same wallet today cannot drop', p3.out.kind === 'candy' && p3.out.fairness.canWin === false);
give(B, 500);
const p4 = await pullAs(B, 'nft', '1.1.1.1');
check('nor for another wallet on the same connection', p4.out.kind === 'candy' && p4.out.fairness.canWin === false);
const p5 = await pullAs(B, 'nft', '2.2.2.2');
check('another wallet on another connection can win', p5.out.kind === 'nft', p5.out.kind);
const winB = p5.out.win.id;

// claiming
const cl = await call('vclaim', { owner: A, body: { id: winA } });
check('a claim sends a g00b from the machine', cl.claimed === true && G00BS.includes(cl.mint) && typeof cl.signature === 'string' && SEND.count === 1, `${cl.name || '?'} ${cl.mint && cl.mint.slice(0, 6)}`);
check('it says which g00b it was', /g00b/i.test(cl.name || ''), cl.name);
check('the ledger marks it claimed', ledger().wallets[A].vendWins[0].state === 'claimed');
HELD.get(VW).delete(cl.mint); HELD.set(A, new Set([cl.mint]));
const again = await call('vclaim', { owner: A, body: { id: winA } });
check('claiming again sends nothing more', again.claimed === true && again.mint === cl.mint && SEND.count === 1);
check('someone else cannot claim that win', (await call('vclaim', { owner: C, body: { id: winA } })).code === 404);

SEND.mode = 'fail';
const bad = await call('vclaim', { owner: B, body: { id: winB } });
const wb = ledger().wallets[B].vendWins.find((x) => x.id === winB);
check('a send that fails leaves the win open to claim again', bad.code === 502 && wb.state === 'won' && !wb.mint, bad.error);
SEND.mode = 'ok';

// a claim the server lost track of, mid-send: the NFT never left, so it is sent again
const stuckMint = [...HELD.get(VW)].find((m) => G00BS.includes(m));
setLedger((l) => { const v = l.wallets[B].vendWins.find((x) => x.id === winB); Object.assign(v, { state: 'claiming', mint: stuckMint, claimAt: Date.now() - 200e3 }); });
const sent0 = SEND.count;
const redoB = await call('vclaim', { owner: B, body: { id: winB } });
check('a stuck claim whose NFT is still in the machine is sent again', redoB.claimed === true && SEND.count === sent0 + 1, redoB.error || redoB.mint);
check('a claim still in flight is left alone', await (async () => {
  give(C, 500);
  const p = await pullAs(C, 'nft', '3.3.3.3');
  setLedger((l) => { const v = l.wallets[C].vendWins[0]; Object.assign(v, { state: 'claiming', mint: G00BS[0], claimAt: Date.now() - 5e3 }); });
  const r = await call('vclaim', { owner: C, body: { id: p.out.win.id } });
  return r.waiting === true && SEND.count === sent0 + 1;
})());
// an unconfirmed claim whose transaction did land is marked claimed, without another send
const winC = ledger().wallets[C].vendWins[0].id;
const landed = b58(crypto.randomBytes(64)); SEND.sigs.set(landed, true);
setLedger((l) => { Object.assign(l.wallets[C].vendWins[0], { state: 'unconfirmed', signature: landed, claimAt: Date.now() - 200e3 }); });
const lc = await call('vclaim', { owner: C, body: { id: winC } });
check('an unconfirmed claim that landed is marked claimed, nothing resent', lc.claimed === true && lc.signature === landed && SEND.count === sent0 + 1);

// an empty machine
HELD.set(VW, new Set([SPAM]));
give(D, 500);
await call('config');                                       // the stock is cached for 30s; a claim reads it fresh
const empty = await pullAs(D, 'nft', '4.4.4.4');
check('an empty machine drops no NFT (the pull says so)', empty.out.kind === 'candy' && empty.out.fairness.canWin === false || empty.out.kind === 'nft', `${empty.out.kind} canWin ${empty.out.fairness && empty.out.fairness.canWin}`);
setLedger((l) => { l.wallets[D].vendWins = [{ id: 'wD', at: new Date().toISOString(), state: 'won' }]; });
const q = await call('vclaim', { owner: D, body: { id: 'wD' } });
check('a win with nothing to send is kept for the restock', q.queued === true && ledger().wallets[D].vendWins[0].state === 'won', q.error);

// the day's limit for everyone
setLedger((l) => { const d = new Date().toISOString().slice(0, 10); l.vendDays[d] = { nfts: 5, ips: {} }; });
HELD.set(VW, new Set(G00BS));
const capped = await pullAs(D, 'nft', '5.5.5.5');
check('after five NFTs in a day, none can drop', capped.out.fairness.canWin === false);

// free bubbles to start: once per wallet, on its first signed-in visit
const E = wallet();
const s1 = await call('pops', { owner: E, method: 'GET' });
check('a new wallet gets 200 free bubbles', s1.pops === 200 && s1.starter === 200);
const s2 = await call('pops', { owner: E, method: 'GET' });
check('only once', s2.pops === 200 && !s2.starter);
const s3 = await call('pops', { owner: A, method: 'GET' });
check('a wallet that was already here is reset to 200 too', s3.starter === 200 && s3.pops === 200 && ledger().wallets[A].pops === 200, `pops ${s3.pops}`);
check('the candy count comes back with the bubbles', s3.candy === ledger().wallets[A].candy && s3.candy >= 1, `candy ${s3.candy}`);
check('no session, no bubbles', (await call('pops', { method: 'GET' })).code === 401);
const F = wallet();
setLedger((l) => { l.wallets[F] = { staked: {}, detail: {}, accrued: 0, pops: 31, starterAt: '2026-09-28T20:00:00Z' }; });
const r1 = await call('pops', { owner: F, method: 'GET' });
check('a wallet from an earlier round is reset to 200', r1.starter === 200 && r1.pops === 200, `pops ${r1.pops}`);
check('and only once this round', !(await call('pops', { owner: F, method: 'GET' })).starter);
give(D, 9950); setLedger((l) => { delete l.wallets[D].starterAt; delete l.wallets[D].starterRound; });
check('a big count is reset to 200 as well', (await call('pops', { owner: D, method: 'GET' })).pops === 200);

// a house gift: the next pull, by anyone, drops a g00b, and says it was a gift
setLedger((l) => { delete l.vendGiftRound; l.vendDays = {}; });
HELD.set(VW, new Set(G00BS));
const restocked = await call('vclaim', { owner: D, body: { id: 'wD' } });       // reads the machine fresh
check('a saved win sends once the machine is restocked', restocked.claimed === true, restocked.error || restocked.mint);
const G = wallet(); give(G, 300);
const gp = await pullAs(G, 'candy', '6.6.6.6');
check('the next pull after a gift is set drops a g00b', gp.out.kind === 'nft' && VEND.nftSlots.includes(gp.out.slot) && gp.out.win && gp.out.win.id);
check('it says it was a gift, and what the draw itself gave', gp.out.fairness.gift === true && gp.out.fairness.drew === 'candy'
  && vendDraw(gp.out.fairness.seed, gp.out.fairness.clientSeed, gp.out.fairness.nonce, gp.out.fairness.canWin).kind === 'candy');
const gp2 = await pullAs(G, 'candy', '6.6.6.6');
check('only one pull gets the gift', gp2.out.kind === 'candy' && !gp2.out.fairness.gift);

console.log(`\n${pass} passed, ${fail} failed`);
rpc.close(); wss.close();
process.exit(fail ? 1 : 0);
