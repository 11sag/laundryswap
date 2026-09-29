// Live washes paid from the player's wallet, end to end, without moving anything:
// the real handler (commit, pay and wash in laundry.js), an in-memory
// ledger, real Jupiter routes, and a local Solana RPC that forwards to mainnet
// except for payments and sends, which it plays itself.
// Run: node --import ./tools-dev-register.mjs tools-laundry-live-test.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import WS from 'ws';
import * as web3 from '@solana/web3.js';
import * as blob from './tools-dev-blob-stub.mjs';

const PORT = 18919, REAL = 'https://api.mainnet-beta.solana.com', LAMPORTS = 1e9, SOL = 'So11111111111111111111111111111111111111112';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => { const d = [0]; for (const b of bytes) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let o = ''; for (const b of bytes) { if (b === 0) o += '1'; else break; } return o + d.reverse().map((x) => B58[x]).join(''); };
const washer = web3.Keypair.generate(), LAUNDRY = washer.publicKey.toBase58();
// failPayout and failRefund refuse the next payout or refund send (a refund carries ':refund' in its memo)
const RPC = { failPayout: 0, failRefund: 0, sends: [], payments: new Map(), flaky: 0, dropped: new Set(), refuseNext: 0 };
// the signature a sent transaction really carries
const sigOf = (b64) => { try { return b58(web3.VersionedTransaction.deserialize(Buffer.from(b64, 'base64')).signatures[0]); } catch { return null; } };
// a payment the "player" made: what the chain would say about it
function pay({ from, lamports, memo }) {
  const sig = b58(crypto.randomBytes(64));
  RPC.payments.set(sig, { from, lamports, memo });
  return sig;
}
const answer = async (m) => {
  const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'getBalance' && m.params[0] === LAUNDRY) return ok({ context: { slot: 1 }, value: 10 * LAMPORTS });
  if (m.method === 'sendTransaction') {
    if (RPC.refuseNext > 0) { RPC.refuseNext--; return { jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'mock: This transaction has already been processed' } }; }
    const isRefund = Buffer.from(m.params[0], 'base64').includes(':refund');
    if (isRefund ? RPC.failRefund > 0 : RPC.failPayout > 0) {
      if (isRefund) RPC.failRefund--; else RPC.failPayout--;
      return { jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'mock: refused' } };
    }
    const real = sigOf(m.params[0]) || b58(crypto.randomBytes(64));
    // flaky: the network takes it but the answer never comes back
    if (RPC.flaky > 0) { RPC.flaky--; RPC.sends.push(real); return { __http: 502 }; }
    RPC.sends.push(real); return ok(real);
  }
  if (m.method === 'getSignatureStatuses') return ok({ context: { slot: globalThis.LAGGING ? 1 : 9e11 }, value: m.params[0].map((x) => RPC.dropped.has(x) ? null : ({ slot: 1, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' })) });
  if (m.method === 'getTransaction') {
    const p = RPC.payments.get(m.params[0]);
    if (!p) return { jsonrpc: '2.0', id: m.id, error: { code: -32004, message: 'mock: not kept' } };
    return ok({ slot: 1, blockTime: 1, transaction: { signatures: [m.params[0]], message: { accountKeys: [p.from, LAUNDRY, '11111111111111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'] } },
      meta: { err: null, fee: 5000, preBalances: [5 * LAMPORTS, 10 * LAMPORTS, 1, 1], postBalances: [5 * LAMPORTS - p.lamports - 5000, 10 * LAMPORTS + p.lamports, 1, 1],
        logMessages: [].concat(p.memo).map((m) => `Program log: Memo (len ${m.length}): "${m}"`), loadedAddresses: { writable: [], readonly: [] } } });
  }
  if (m.method === 'getSignaturesForAddress' && m.params[0] === LAUNDRY) {
    return ok([...RPC.payments.entries()].map(([signature, p]) => ({ signature, err: null, memo: [].concat(p.memo).map((m) => `[${m.length}] ${m}`).join('; '), slot: 1 })));
  }
  return (await fetch(REAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) })).json();
};
const rpc = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const msg = JSON.parse(body);
  const out = Array.isArray(msg) ? await Promise.all(msg.map(answer)) : await answer(msg);
  if (out && out.__http) { res.writeHead(out.__http); return res.end('bad gateway'); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
}).listen(PORT);
const wss = new WS.Server({ port: PORT + 1 }); let sub = 0;
wss.on('connection', (ws) => ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.method === 'signatureSubscribe') { const id = ++sub; ws.send(JSON.stringify({ jsonrpc: '2.0', result: id, id: m.id }));
    setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'signatureNotification', params: { result: { context: { slot: 1 }, value: { err: null } }, subscription: id } })), 50); }
  else if (m.method && m.method.endsWith('Unsubscribe')) ws.send(JSON.stringify({ jsonrpc: '2.0', result: true, id: m.id }));
}));

Object.assign(process.env, { LAUNDRY_NEW_WALLETS_PER_IP: '1000', CRON_SECRET: 'cron-test', AUTH_SECRET: 'test-secret', SOLANA_NETWORK: 'mainnet', LAUNDRY_LIVE: '1', LAUNDRY_SECRET: b58(washer.secretKey),
  MAINNET_RPC_URL: `http://127.0.0.1:${PORT}`, SOLANA_RPC_URL: `http://127.0.0.1:${PORT}` });
delete process.env.GIVEAWAY_SECRET;
const laundry = (await import('./api/laundry.js')).default;
const mac = (s) => crypto.createHmac('sha256', 'test-secret').update(s).digest('base64url');
const session = (owner) => { const p = Buffer.from(JSON.stringify({ owner, exp: Date.now() + 36e5 })).toString('base64url'); return p + '.' + mac('s:' + p); };
function call(handler, q, { owner, body, method = 'POST', query = {}, ip = '1.1.1.1', headers = {} } = {}) {
  const req = { method, query: { q, ...query }, body: body || {}, headers: { 'x-forwarded-for': ip, ...(owner ? { authorization: 'Bearer ' + session(owner) } : {}), ...headers } };
  return new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { resolve({ code: this.code, ...d }); }, send() { resolve({ code: this.code }); }, end() { resolve({ code: this.code }); } };
    handler(req, res);
  });
}
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const wallet = () => web3.Keypair.generate().publicKey.toBase58();
const [A, B, C, D, E] = [wallet(), wallet(), wallet(), wallet(), wallet()];
blob.seed('laundry/ledger.json', { wallets: {}, mints: {} });
const job = (o, id) => (blob.read('laundry/ledger.json').wallets[o].laundry || []).find((j) => j.id === id);
const commit = (o) => call(laundry, 'commit', { owner: o, method: 'GET' });
const RANGE = { lo: 0.078, hi: 0.071 };
const payFor = (o, { inMint = SOL, amount = String(0.1 * LAMPORTS), mint = BONK, range = RANGE } = {}) => call(laundry, 'pay', { owner: o, body: { in: inMint, amount, mint, clientSeed: 'test', range } });
const wash = (o, body) => call(laundry, 'wash', { owner: o, body });
let pass = 0, fail = 0;
const check = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

const cfg = await call(laundry, 'config', { method: 'GET' });
check('live, and the full range on a 10 SOL float', cfg.live === true && cfg.max === 0.5 * LAMPORTS, `max ${cfg.max / LAMPORTS}`);
check('pay needs a session', (await payFor(null)).code === 401);
check('pay needs a commitment first', (await payFor(A)).recommit === true);
check('a range the machine could not roll is refused', /fee range/.test((await payFor(A, { range: { lo: 0.02, hi: 0.1 } })).error));

// the payment the wallet is asked to approve
await commit(A);
const p1 = await payFor(A);
const tx = web3.VersionedTransaction.deserialize(Buffer.from(p1.tx, 'base64'));
const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
const memoIx = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const xferIx = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === '11111111111111111111111111111111');
const xferLamports = xferIx ? Number(Buffer.from(xferIx.data).readBigUInt64LE(4)) : null;
check('payment: the player pays the fee', keys[0] === A);
check('payment: exactly 0.1 SOL to the laundry', xferIx && keys[xferIx.accountKeyIndexes[1]] === LAUNDRY && xferLamports === 0.1 * LAMPORTS && p1.lamports === xferLamports);
check('payment: memo ties it to this wash', memoIx && Buffer.from(memoIx.data).toString() === 'laundry:' + p1.job);

check('a payment from another wallet is refused', /another wallet/.test((await wash(A, { job: p1.job, signature: pay({ from: B, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + p1.job }) })).error));
// that attempt ends this wash (the payment was not the player's), so start again
await commit(A);
const p2 = await payFor(A);
check('a payment for another wash is refused', /another wash/.test((await wash(A, { job: p2.job, signature: pay({ from: A, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + p1.job }) })).error));
await commit(A);
const p3 = await payFor(A);
const sig3 = pay({ from: A, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + p3.job });
const sendsBefore = RPC.sends.length;
const r3 = await wash(A, { job: p3.job, signature: sig3 });
check('paid wash pays out', r3.code === 200 && r3.live && r3.out > 0 && r3.paySignature === sig3, `${r3.cycle && r3.cycle.name} ${r3.cycle && r3.cycle.mult}x, washed ${r3.washed} lamports, out ${r3.out} BONK`);
check('payout is the paid amount times the cycle, less a new token account', r3.washed === Math.floor(0.1 * LAMPORTS * r3.cycle.mult) - 2039280);
check('seed revealed matches the commitment', crypto.createHash('sha256').update(r3.fairness.seed).digest('hex') === r3.fairness.hash);
check('the outcome sits inside the range the player saw', r3.cycle.mult >= 1 - RANGE.lo && r3.cycle.mult <= 1 + RANGE.hi && Math.abs(r3.cycle.mult - 1) >= 0.01 && r3.fairness.range.lo === RANGE.lo, `mult ${r3.cycle.mult}`);
const again = await wash(A, { job: p3.job, signature: sig3 });
check('asking again returns the same wash, no second payout', again.signature === r3.signature && RPC.sends.length - sendsBefore === 1);
check('ledger: done, with both signatures', job(A, p3.job).state === 'done' && job(A, p3.job).paySig === sig3 && job(A, p3.job).outSig === r3.signature);

// a payout that cannot be sent is refunded
await commit(B);
const p4 = await payFor(B);
RPC.failPayout = 1;
const r4 = await wash(B, { job: p4.job, signature: pay({ from: B, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + p4.job }) });
check('failed payout refunds the payment', r4.code === 502 && /sent back/.test(r4.error) && job(B, p4.job).state === 'refunded' && job(B, p4.job).refund, r4.error);

// a short payment gets its own amount back
await commit(C);
const p5 = await payFor(C);
const r5 = await wash(C, { job: p5.job, signature: pay({ from: C, lamports: 0.03 * LAMPORTS, memo: 'laundry:' + p5.job }) });
check('short payment is refunded', r5.code === 502 && /short/.test(r5.error) && job(C, p5.job).state === 'refunded');

// the page reloaded mid-wash: no signature, the laundry finds the payment by its memo
await commit(D);
const p6 = await payFor(D);
pay({ from: D, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + p6.job });
const r6 = await wash(D, { job: p6.job });
check('a wash with a lost signature still finishes', r6.code === 200 && r6.live, `out ${r6.out}`);

// a refund the network refuses is tried again on the next ask
const [F] = [wallet()];
await commit(F);
const pF = await payFor(F);
RPC.failPayout = 1; RPC.failRefund = 1;                   // the payout, then the refund
const sigF = pay({ from: F, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + pF.job });
const f1 = await wash(F, { job: pF.job, signature: sigF });
check('refund that fails leaves the wash waiting, not over', f1.code === 202 && f1.waiting && job(F, pF.job).state === 'stuck', f1.error);
const f2 = await wash(F, { job: pF.job });
check('the next ask sends the refund', f2.code === 502 && /sent back/.test(f2.error) && job(F, pF.job).state === 'refunded' && job(F, pF.job).refund, JSON.stringify(f2).slice(0, 120) + ' state ' + job(F, pF.job).state + ' | ' + job(F, pF.job).refundError);

// two requests for the same wash at once pay out once
await new Promise((r) => setTimeout(r, 8000));
await commit(E);
const p7 = await payFor(E);
const sig7 = pay({ from: E, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + p7.job });
const before7 = RPC.sends.length;
const [x1, x2] = await Promise.all([wash(E, { job: p7.job, signature: sig7 }), wash(E, { job: p7.job, signature: sig7 })]);
// the rule that matters: one transaction out, however the race lands (paid, or
// refunded when the busy public RPC refuses the payout build)
check('double submit sends once', RPC.sends.length - before7 === 1 && ['done', 'refunded'].includes(job(E, p7.job).state), `codes ${x1.code}/${x2.code} sends ${RPC.sends.length - before7} | ${JSON.stringify(x1).slice(0, 160)} | ${JSON.stringify(x2).slice(0, 160)} | state ${job(E, p7.job).state}`);

// any token in: USDC swapped to SOL inside the payment, SOL out of the laundry
await new Promise((r) => setTimeout(r, 12000));            // let the public RPC's rate limit reset
await commit(A);
const p8 = await payFor(A, { inMint: USDC, amount: String(15e6), mint: SOL });
if (!p8.tx) { console.log('USDC pay answered', JSON.stringify(p8)); process.exit(1); }
const tx8 = web3.VersionedTransaction.deserialize(Buffer.from(p8.tx, 'base64'));
const k8 = tx8.message.staticAccountKeys.map((k) => k.toBase58());
const x8 = tx8.message.compiledInstructions.filter((i) => k8[i.programIdIndex] === '11111111111111111111111111111111').pop();
check('USDC payment sends its swap floor to the laundry', p8.code === 200 && x8 && Number(Buffer.from(x8.data).readBigUInt64LE(4)) === p8.lamports, `${p8.lamports} lamports`);
const r8 = await wash(A, { job: p8.job, signature: pay({ from: A, lamports: p8.lamports, memo: 'laundry:' + p8.job }) });
check('washing into SOL pays SOL straight back', r8.code === 200 && r8.token.symbol === 'SOL' && r8.washed === Math.floor(p8.lamports * r8.cycle.mult), `${r8.cycle && r8.cycle.mult}x -> ${r8.out} SOL`);
check('too big for the limits is refused', (await (async () => { await commit(C); return payFor(C, { amount: String(0.6 * LAMPORTS) }); })()).code === 400);
// ---- a payout whose send errors is never followed by a second payment ----
const Y = wallet();
await commit(Y); const py1 = await payFor(Y);
RPC.flaky = 3;                                            // every try errors, though the first one went out
const sendsY = RPC.sends.length;
const fy = await wash(Y, { job: py1.job, signature: pay({ from: Y, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + py1.job }) });
const jy = job(Y, py1.job);
check('a payout that went out though every send errored is not refunded', fy.code === 200 && jy.state === 'done' && !jy.refund && new Set(RPC.sends.slice(sendsY)).size === 1,
  `code ${fy.code} state ${jy.state} sends ${RPC.sends.length - sendsY}`);
// a wash left unconfirmed settles from the chain: landed means done, gone means one refund
const Z = wallet();
const landedSig = b58(crypto.randomBytes(64)), goneSig = b58(crypto.randomBytes(64)); RPC.dropped.add(goneSig);
const stale = new Date(Date.now() - 5 * 60e3).toISOString();
async function leftAs(v) {                                  // a wash, then left in the given state
  await commit(Z); const p = await payFor(Z);
  const l = blob.read('laundry/ledger.json');
  Object.assign(l.wallets[Z].laundry.find((x) => x.id === p.job), { paySig: b58(crypto.randomBytes(64)), paid: 0.1 * LAMPORTS, claimedAt: stale, ...v });
  blob.seed('laundry/ledger.json', l);
  return p;
}
const pz1 = await leftAs({ state: 'unconfirmed', outSig: landedSig, outValid: 1, once: 1, washed: 101000000, base: 0.1 * LAMPORTS, quoteOut: '3000000' });
const pz2 = await leftAs({ state: 'unconfirmed', outSig: goneSig, outValid: 1, once: 1 });
const pz3 = await leftAs({ state: 'washing', once: 1 });
const pz4 = await leftAs({ state: 'washing' });
const before8 = RPC.sends.length;
const s1 = await wash(Z, { job: pz1.job });
check('an unconfirmed payout that landed is marked done, nothing sent', s1.code === 200 && s1.live && job(Z, pz1.job).state === 'done' && RPC.sends.length === before8, `code ${s1.code}`);
const s2 = await wash(Z, { job: pz2.job });
check('an unconfirmed payout that can never land is refunded once', s2.code === 502 && /sent back/.test(s2.error) && s2.final && job(Z, pz2.job).state === 'refunded' && RPC.sends.length === before8 + 1, s2.error);
check('asking again sends no second refund', (await wash(Z, { job: pz2.job })).code === 400 && RPC.sends.length === before8 + 1);
const s3 = await wash(Z, { job: pz3.job });
check('a wash whose server stopped before paying out is refunded', s3.code === 502 && job(Z, pz3.job).state === 'refunded', s3.error);
const s4 = await wash(Z, { job: pz4.job });
check('an older wash with no record of its payout waits for a person', s4.code === 202 && job(Z, pz4.job).state === 'washing');

// ---- one payment can only ever pay for one wash ----
const X = wallet();
await commit(X); const px1 = await payFor(X);
await commit(X); const px2 = await payFor(X);
const both = pay({ from: X, lamports: 0.1 * LAMPORTS, memo: ['laundry:' + px1.job, 'laundry:' + px2.job] });
const sendsX = RPC.sends.length;
const bx1 = await wash(X, { job: px1.job, signature: both }), bx2 = await wash(X, { job: px2.job, signature: both });
check('a payment carrying two washes\' memos pays neither', bx1.code === 400 && bx2.code === 400 && RPC.sends.length === sendsX, `${bx1.error} | ${bx2.error}`);
await commit(X); const px3 = await payFor(X); await commit(X); const px4 = await payFor(X);
const one = pay({ from: X, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + px3.job });
const ok3 = await wash(X, { job: px3.job, signature: one }), again4 = await wash(X, { job: px4.job, signature: one });
check('the same payment cannot pay a second wash', ok3.code === 200 && again4.code === 400, again4.error);

// ---- lucky socks: invite links, the swap bonus, and Free Rinse ----
const led = () => blob.read('laundry/ledger.json');
const INV = wallet(), FR = [wallet(), wallet(), wallet()];
const mine = await call(laundry, 'ref', { owner: INV, method: 'GET' });
check('every wallet gets an invite code', /^[A-Za-z0-9]{8}$/.test(mine.code || ''), mine.code);
check('your own link pays nothing', (await call(laundry, 'ref', { owner: INV, body: { code: mine.code } })).bonus === 0);
const j1 = await call(laundry, 'ref', { owner: FR[0], body: { code: mine.code }, ip: '7.0.0.1' });
check('a friend who joins gets 300 on top of the free 200', j1.bonus === 300 && j1.pops === 500, `pops ${j1.pops}`);
check('and so does the wallet that sent them', led().wallets[INV].pops === 300 && led().wallets[INV].refJoined === 1);
check('one link a day per connection', (await call(laundry, 'ref', { owner: FR[1], body: { code: mine.code }, ip: '7.0.0.1' })).bonus === 0);
check('a wallet only joins once', (await call(laundry, 'ref', { owner: FR[0], body: { code: mine.code }, ip: '7.0.0.9' })).bonus === 0);
await call(laundry, 'ref', { owner: FR[1], body: { code: mine.code }, ip: '7.0.0.2' });
await call(laundry, 'ref', { owner: FR[2], body: { code: mine.code }, ip: '7.0.0.3' });
async function solWash(o) {
  await commit(o);
  const p = await payFor(o);
  return wash(o, { job: p.job, signature: pay({ from: o, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + p.job }) });
}
const fw = await solWash(FR[0]);
check('a friend\'s first swap pays the sender 500', fw.code === 200 && led().wallets[INV].pops === 1400 && led().wallets[INV].refSwaps === 1, `pops ${led().wallets[INV].pops}`);
await solWash(FR[0]);
check('only the first swap pays', led().wallets[INV].refSwaps === 1);
check('no Free Rinse before 3 friends swap', !led().wallets[INV].freeRinseUntil);
await solWash(FR[1]); await solWash(FR[2]);
const until = led().wallets[INV].freeRinseUntil;
check('3 friends who swap give 7 days of Free Rinse', until && Math.abs(until - Date.now() - 7 * 864e5) < 60e3);
const rinsed = [];
for (let i = 0; i < 5; i++) rinsed.push(await solWash(INV));
check('no fees: every covered wash is a plain swap', rinsed.every((r) => r.code === 200 && r.cycle.mult === 1 && r.cycle.key === 'rinse' && r.fairness.freeRinse), rinsed.map((r) => r.cycle && r.cycle.name + ' ' + r.cycle.mult).join(', '));
check('and each shows what the draw itself gave', rinsed.every((r) => typeof r.cycle.drew === 'number' && r.cycle.drew !== 1));
const info = await call(laundry, 'ref', { owner: INV, method: 'GET' });
check('5 a day, then it waits for tomorrow', info.rinseLeft === 0 && info.rinseUntil === until && info.swapped === 3 && info.joined === 3);
const big = await (async () => { await commit(INV); return payFor(INV, { amount: String(0.2 * LAMPORTS) }); })();
check('bigger washes are not covered', big.code === 200);


// ---- nothing a page loses can lose a payment ----
{
  // a wallet that only signs: the page hands over the signed payment, and the node says it was sent already
  const S = wallet();
  await commit(S); const ps = await payFor(S);
  const stx = web3.VersionedTransaction.deserialize(Buffer.from(ps.tx, 'base64'));
  const sigBytes = crypto.randomBytes(64); stx.signatures[0] = sigBytes;
  const ssig = b58(sigBytes);
  RPC.payments.set(ssig, { from: S, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + ps.job });
  RPC.refuseNext = 1;
  const r = await wash(S, { job: ps.job, signed: Buffer.from(stx.serialize()).toString('base64') });
  check('a signed payment the node calls already sent still washes', r.code === 200 && r.live && job(S, ps.job).paySig === ssig, r.error);
}
{
  // the laundry's own jam (its store unreachable) is never "over": the page keeps the wash
  const J = wallet();
  await commit(J); const pj = await payFor(J);
  pay({ from: J, lamports: 0.1 * LAMPORTS, memo: 'laundry:' + pj.job });
  blob.knobs.failGets = 1;
  const r = await wash(J, { job: pj.job });
  check('a jam of the laundry\'s own is never final, so the page keeps the wash', r.code === 502 && !r.final, `${r.code} final ${r.final}`);
  const r2 = await wash(J, { job: pj.job });
  check('and the next ask finishes it', r2.code === 200 && r2.live, r2.error);
}
{
  // two asks at once on a wash owed a refund: one refund, not two
  const pr = await leftAs({ state: 'stuck', refundLamports: 0.1 * LAMPORTS, error: 'The wash could not start.' });
  const before = RPC.sends.length;
  const both = await Promise.all([wash(Z, { job: pr.job }), wash(Z, { job: pr.job })]);
  const again = await wash(Z, { job: pr.job });
  check('two asks at once send one refund, not two', RPC.sends.length === before + 1 && job(Z, pr.job).state === 'refunded' && again.final,
    `${RPC.sends.length - before} sent; ${both.map((x) => x.code).join(' ')} then ${again.code}`);
}
{
  // a payment signature that can never land lets its wash go, so the wallet is not locked out
  const X = wallet();
  await commit(X); const px = await payFor(X);
  const ghost = b58(crypto.randomBytes(64)); RPC.dropped.add(ghost);
  const l = blob.read('laundry/ledger.json');
  Object.assign(l.wallets[X].laundry.find((j) => j.id === px.job), { paySig: ghost, payValid: 1, at: stale });
  blob.seed('laundry/ledger.json', l);
  const r = await wash(X, { job: px.job });
  check('a payment that can never land ends its wash, nothing taken', r.code === 400 && r.final && job(X, px.job).state === 'expired', r.error);
}
{
  // a status node that is behind cannot make a sent payout look lost
  const lagSig = b58(crypto.randomBytes(64)); RPC.dropped.add(lagSig);
  const pl = await leftAs({ state: 'unconfirmed', outSig: lagSig, outValid: 1, once: 1 });
  const before = RPC.sends.length;
  globalThis.LAGGING = true;
  const r = await wash(Z, { job: pl.job });
  globalThis.LAGGING = false;
  check('a node that is behind never makes a sent payout look lost', r.code === 202 && r.waiting && RPC.sends.length === before && job(Z, pl.job).state === 'unconfirmed', `${r.code}`);
  const r2 = await wash(Z, { job: pl.job });
  check('a node that is caught up settles it: refunded once', r2.code === 502 && r2.refunded && r2.final && RPC.sends.length === before + 1);
}
{
  // the sweeper finishes what a page left behind, and only for the cron
  check('the sweeper needs its key', (await call(laundry, 'sweep', { method: 'GET' })).code === 401);
  const wonSig = b58(crypto.randomBytes(64));
  const pw = await leftAs({ state: 'unconfirmed', outSig: wonSig, outValid: 1, once: 1, washed: 101000000, base: 0.1 * LAMPORTS, quoteOut: '3000000' });
  const sw = await call(laundry, 'sweep', { method: 'GET', headers: { authorization: 'Bearer cron-test' } });
  check('the sweeper finishes a wash a page left behind', sw.code === 200 && job(Z, pw.job).state === 'done', JSON.stringify(sw.seen || sw).slice(0, 160));
}
{
  // bubble counts: each wallet's own file, taken into the ledger when shown or spent
  const P = wallet();
  await call(laundry, 'pops', { owner: P, method: 'GET' });
  const r1 = await call(laundry, 'pops', { owner: P, body: { n: 3 } });
  check('pops are counted in the wallet\'s own file, not the shared ledger', r1.added === 3 && blob.read('laundry/pops/' + P + '.json').total === 3 && led().wallets[P].pops === 200);
  const g1 = await call(laundry, 'pops', { owner: P, method: 'GET' });
  check('showing the count takes them in', g1.pops === 203 && led().wallets[P].pops === 203 && led().wallets[P].popsTaken === 3, `${g1.pops}`);
  const g2 = await call(laundry, 'pops', { owner: P, method: 'GET' });
  check('taking them in again adds nothing', g2.pops === 203 && led().wallets[P].pops === 203);
}

// ---- paying from another chain, through a stand-in for Relay ----
const RELAYSIM = { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', router: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', mode: 'ok', status: new Map(), quotes: [],
  approveAmount: null, spender: null, skipApprove: false, direct: false, directAmount: null };
const PEPE_ETH = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const SOL_PER = { 1: 22.5, 8453: 22.5, 4663: 22.4, 56: 7 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.relay.link')) return realFetch(url, opts);
  const reply = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
  if (u.includes('/quote')) {
    const b = JSON.parse(opts.body);
    if (RELAYSIM.mode === 'toolow' || BigInt(b.amount) < 1000000000000000n) return reply(400, { message: 'too small', errorCode: 'AMOUNT_TOO_LOW' });
    const token = b.originCurrency !== '0x0000000000000000000000000000000000000000';
    const out = token ? Math.floor(Number(b.amount) / 1e18 * 0.0000000352 * 1e9) : Math.floor(Number(b.amount) / 1e18 * SOL_PER[b.originChainId] * 1e9), requestId = '0x' + crypto.randomBytes(32).toString('hex');
    RELAYSIM.quotes.push({ requestId, out, body: b });
    const hex = (n, w = 64) => BigInt(n).toString(16).padStart(w, '0');
    const steps = [];
    if (token && !RELAYSIM.skipApprove) steps.push({ id: 'approve', kind: 'transaction', requestId, items: [{ status: 'incomplete', data: { from: b.user, to: b.originCurrency,
      data: '0x095ea7b3' + '0'.repeat(24) + (RELAYSIM.spender || (RELAYSIM.direct ? RELAYSIM.to : RELAYSIM.router)).slice(2) + hex(RELAYSIM.approveAmount || b.amount), value: '0', chainId: b.originChainId } }] });
    const word = (a) => '0'.repeat(24) + a.slice(2).toLowerCase();
    const depData = token && RELAYSIM.direct ? '0xe8017952' + word(b.user) + word(b.originCurrency) + hex(RELAYSIM.directAmount || b.amount) + crypto.randomBytes(32).toString('hex')
      : '0x49290c1c' + '0'.repeat(56);
    steps.push({ id: 'deposit', kind: 'transaction', requestId, items: [{ status: 'incomplete',
      data: { from: b.user, to: token ? (RELAYSIM.direct ? RELAYSIM.to : RELAYSIM.router) : RELAYSIM.to, data: depData, value: token ? '0' : b.amount, chainId: b.originChainId, gas: '32713' } }] });
    return reply(200, { steps,
      details: { sender: b.user, recipient: b.recipient, currencyIn: { amount: b.amount, amountUsd: String(Number(b.amount) / 1e18 * (token ? 0.0000092 : 2650)),
        ...(token ? { currency: { address: b.originCurrency, symbol: 'PEPE', name: 'Pepe', decimals: 18 } } : {}) },
        currencyOut: { amount: String(out), minimumAmount: String(Math.floor(out * 0.99)), currency: { address: '11111111111111111111111111111111', decimals: 9 } }, timeEstimate: 1 } });
  }
  if (u.includes('/intents/status/v3')) return reply(200, RELAYSIM.status.get(new URL(u).searchParams.get('requestId')) || { status: 'unknown' });
  return reply(404, {});
};
const SOLVER = wallet(), EVMFROM = '0x' + 'ab'.repeat(20), ETH01 = '10000000000000000';
const eq = await call(laundry, 'quote', { method: 'GET', query: { in: 'evm:base', amount: ETH01, mint: BONK } });
check('a quote in ETH on Base says what it is worth in SOL and what it buys', eq.code === 200 && eq.lamports === 225000000 && eq.out > 0 && eq.from.name === 'ETH on Base' && eq.inMint === 'evm:base', `${eq.lamports} lamports, ${eq.out} BONK`);
const eqs = await call(laundry, 'quote', { method: 'GET', query: { in: 'evm:bnb', amount: '100000000000000000', mint: SOL } });
check('BNB straight to SOL is priced too', eqs.code === 200 && eqs.out === 0.7 && eqs.token.symbol === 'SOL', `${eqs.out} SOL`);
const small = await call(laundry, 'quote', { method: 'GET', query: { in: 'evm:eth', amount: '100000000000000', mint: BONK } });
check('too little to cross says what it is worth, for the limits', small.noRoute === true && small.lamports > 0 && small.lamports < 5e7, `${small.lamports} lamports`);
const G1 = wallet();
async function evmPay(o, { chain = 'base', amount = ETH01, mint = BONK, from = EVMFROM } = {}) {
  await commit(o);
  return call(laundry, 'pay', { owner: o, body: { in: 'evm:' + chain, amount, from, mint, clientSeed: 'test', range: RANGE } });
}
const ep = await evmPay(G1);
const ej = () => job(G1, ep.job);
check('paying from Base sets up a wash tied to one Relay request', ep.code === 200 && ep.evm && ep.evm.to === RELAYSIM.to && ep.evm.value === ETH01 && ep.evm.chainId === 8453
  && ej().kind === 'evm' && ej().requestId === RELAYSIM.quotes.at(-1).requestId && RELAYSIM.quotes.at(-1).body.recipient === LAUNDRY && RELAYSIM.quotes.at(-1).body.user === EVMFROM);
check('the wash is quoted with the laundry as the receiver, 1% slippage', RELAYSIM.quotes.at(-1).body.slippageTolerance === '100' && ej().expect === Math.floor(225000000 * 0.99) && ej().quoted === 225000000);
const w1 = await wash(G1, { job: ep.job, evmTx: '0x' + 'cd'.repeat(32) });
check('before Relay fills it, the wash waits', w1.code === 202 && w1.waiting && ej().state === 'awaiting' && ej().evmTx === '0x' + 'cd'.repeat(32));
const fill1 = pay({ from: SOLVER, lamports: 225000000, memo: 'relay fill' });
RELAYSIM.status.set(ej().requestId, { status: 'success', txHashes: [fill1] });
const w2 = await wash(G1, { job: ep.job });
check('once the SOL lands with the laundry, the wash runs and pays out on Solana', w2.code === 200 && w2.live && w2.out > 0 && w2.lamports === 225000000 && ej().state === 'done' && ej().paySig === fill1,
  `${w2.cycle && w2.cycle.name} ${w2.cycle && w2.cycle.mult}x, ${w2.out} BONK`);
check('the result links the payment on Base', w2.payChain === 'Base' && w2.payExplorer === 'https://basescan.org/tx/0x' + 'cd'.repeat(32));
check('the payout is what arrived times the cycle', w2.washed === Math.floor(225000000 * w2.cycle.mult) - 2039280);
const sendsNow = RPC.sends.length;
const w3 = await wash(G1, { job: ep.job });
check('asking again sends nothing more', w3.signature === w2.signature && RPC.sends.length === sendsNow);
// ETH straight to SOL
const G2 = wallet();
const ep2 = await evmPay(G2, { chain: 'robinhood', mint: SOL });
RELAYSIM.status.set(job(G2, ep2.job).requestId, { status: 'success', txHashes: [pay({ from: SOLVER, lamports: 224000000, memo: 'relay fill' })] });
const w4 = await wash(G2, { job: ep2.job, evmTx: '0x' + 'ef'.repeat(32) });
check('ETH on Robinhood Chain to SOL pays SOL back', w4.code === 200 && w4.token.symbol === 'SOL' && w4.washed === Math.floor(Math.min(224000000, job(G2, ep2.job).quoted) * w4.cycle.mult) && w4.payChain === 'Robinhood Chain', `${w4.cycle && w4.cycle.mult}x -> ${w4.out} SOL`);
// a fill that comes in short is refunded in SOL
const G3 = wallet();
const ep3 = await evmPay(G3);
RELAYSIM.status.set(job(G3, ep3.job).requestId, { status: 'success', txHashes: [pay({ from: SOLVER, lamports: 150000000, memo: 'relay fill' })] });
const w5 = await wash(G3, { job: ep3.job });
check('a fill that comes in short is sent back as SOL', w5.code === 502 && /short/.test(w5.error) && job(G3, ep3.job).state === 'refunded' && job(G3, ep3.job).refundLamports === 150000000, w5.error);
// Relay gives up and refunds on the other chain
const G4 = wallet();
const ep4 = await evmPay(G4);
RELAYSIM.status.set(job(G4, ep4.job).requestId, { status: 'refund', txHashes: [] });
const w6 = await wash(G4, { job: ep4.job });
check('when Relay sends it back, the wash ends with nothing taken', w6.code === 400 && /could not cross/.test(w6.error) && job(G4, ep4.job).state === 'failed', w6.error);
// a payment that never left the wallet lapses after half an hour
const G5 = wallet();
const ep5 = await evmPay(G5);
{ const l = blob.read('laundry/ledger.json'); l.wallets[G5].laundry[0].at = new Date(Date.now() - 31 * 60e3).toISOString(); blob.seed('laundry/ledger.json', l); }
const w7 = await wash(G5, { job: ep5.job });
check('a payment that never left lapses after half an hour', w7.code === 400 && /never left/.test(w7.error) && job(G5, ep5.job).state === 'expired');
// the server refuses what it should not pass on
RELAYSIM.to = '0x1111111111111111111111111111111111111111';
const bad = await evmPay(wallet());
check('a Relay answer paying anywhere else is refused', bad.code === 502 && !bad.evm);
RELAYSIM.to = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
check('a bad paying address is refused', (await evmPay(wallet(), { from: 'nope' })).code === 400);
check('too little to cross is refused with a plain reason', /too little/.test((await evmPay(wallet(), { amount: '100000000000000' })).error));
check('too much for the machine is refused', /Washes run from/.test((await evmPay(wallet(), { amount: '50000000000000000' })).error));
const rec = await call(laundry, 'recent', { method: 'GET' });
const er = (rec.washes || []).find((x) => x.inSymbol === 'ETH on Base' && x.state === 'done');
check('recent washes show the Base payment with its link', er && er.payUrl === 'https://basescan.org/tx/0x' + 'cd'.repeat(32) && er.paid === 0.01);
// a token: PEPE on Ethereum, approved for exactly the amount, then paid through Relay's router
const PEPE2M = '2000000000000000000000000';
const pq = await call(laundry, 'quote', { method: 'GET', query: { in: 'evm:eth:' + PEPE_ETH, amount: PEPE2M, mint: BONK } });
check('a token on Ethereum is priced, with its own name', pq.code === 200 && pq.from.symbol === 'PEPE' && pq.from.name === 'Pepe on Ethereum' && pq.inMint === 'evm:eth:' + PEPE_ETH && pq.lamports === RELAYSIM.quotes.at(-1).out, `${pq.lamports} lamports`);
const T1 = wallet();
const tp = await evmPay(T1, { chain: 'eth:' + PEPE_ETH, amount: PEPE2M });
check('paying with a token: an exact approval to Relay\'s router, then the payment through it', tp.code === 200 && tp.approve && tp.approve.to === PEPE_ETH
  && tp.approve.data.endsWith(BigInt(PEPE2M).toString(16).padStart(64, '0')) && tp.evm.to === RELAYSIM.router && tp.evm.value === '0' && job(T1, tp.job).token === PEPE_ETH);
RELAYSIM.status.set(job(T1, tp.job).requestId, { status: 'success', txHashes: [pay({ from: SOLVER, lamports: 70400000, memo: 'relay fill' })] });
const tw = await wash(T1, { job: tp.job, evmTx: '0x' + '12'.repeat(32) });
check('the token wash runs once the SOL lands', tw.code === 200 && tw.live && tw.lamports === job(T1, tp.job).quoted && tw.payChain === 'Ethereum', `${tw.cycle && tw.cycle.name} ${tw.out} BONK`);
RELAYSIM.skipApprove = true;
check('with an approval already in place, the payment alone is fine', (await evmPay(wallet(), { chain: 'eth:' + PEPE_ETH, amount: PEPE2M })).code === 200);
RELAYSIM.skipApprove = false;
RELAYSIM.approveAmount = '0x' + 'f'.repeat(64);
check('an approval for more than the amount is refused', (await evmPay(wallet(), { chain: 'eth:' + PEPE_ETH, amount: PEPE2M })).code === 502);
RELAYSIM.approveAmount = null; RELAYSIM.spender = '0x2222222222222222222222222222222222222222';
check('an approval to anyone but Relay\'s router is refused', (await evmPay(wallet(), { chain: 'eth:' + PEPE_ETH, amount: PEPE2M })).code === 502);
RELAYSIM.spender = null; RELAYSIM.router = '0x3333333333333333333333333333333333333333';
check('a token payment through anything but Relay\'s router is refused', (await evmPay(wallet(), { chain: 'eth:' + PEPE_ETH, amount: PEPE2M })).code === 502);
RELAYSIM.router = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
// a token paid straight into Relay's receiver (how USDC and USDT come across), its arguments checked
RELAYSIM.direct = true;
const dp = await evmPay(wallet(), { chain: 'eth:' + PEPE_ETH, amount: PEPE2M });
check('a token paid straight into Relay\'s receiver is accepted, approval to the receiver', dp.code === 200 && dp.evm.to === RELAYSIM.to && dp.evm.data.startsWith('0xe8017952')
  && dp.approve && dp.approve.data.slice(34, 74) === RELAYSIM.to.slice(2), dp.error);
RELAYSIM.directAmount = (BigInt(PEPE2M) * 2n).toString();
check('a receiver payment for any other amount is refused', (await evmPay(wallet(), { chain: 'eth:' + PEPE_ETH, amount: PEPE2M })).code === 502);
RELAYSIM.direct = false; RELAYSIM.directAmount = null;
await new Promise((r) => setTimeout(r, 21000));                 // the list is cached for 20 seconds
const rec2 = await call(laundry, 'recent', { method: 'GET' });
check('recent washes name the token and its chain', (rec2.washes || []).some((x) => x.inSymbol === 'PEPE on Ethereum' && x.paid === 2000000));
globalThis.fetch = realFetch;

console.log(`${pass} passed, ${fail} failed`);
rpc.close(); wss.close(); process.exit(fail ? 1 : 0);
