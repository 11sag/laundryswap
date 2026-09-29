// Bubble giveaway, end to end, without moving anything: the real handler, an
// in-memory ledger, real Jupiter routes, and a local Solana RPC that forwards to
// mainnet except for the calls that would spend money, which it answers itself.
// Run: node --import ./tools-dev-register.mjs tools-gift-test.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import WS from 'ws';
import * as web3 from '@solana/web3.js';
import * as blob from './tools-dev-blob-stub.mjs';

const PORT = 18899, REAL = 'https://api.mainnet-beta.solana.com';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => { const d = [0]; for (const b of bytes) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let o = ''; for (const b of bytes) { if (b === 0) o += '1'; else break; } return o + d.reverse().map((x) => B58[x]).join(''); };
const giver = web3.Keypair.generate();                     // a throwaway, never funded
const SEND = { mode: 'ok', count: 0 };

// ---- the stand-in RPC ----
const answer = async (m) => {
  const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'getBalance' && m.params[0] === giver.publicKey.toBase58()) return ok({ context: { slot: 1 }, value: 10e9 });
  if (m.method === 'sendTransaction') {
    SEND.count++;
    if (SEND.mode === 'fail') return { jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'mock: refused before sending' } };
    return ok(b58(crypto.randomBytes(64)));
  }
  if (m.method === 'getSignatureStatuses') return ok({ context: { slot: 1 }, value: m.params[0].map(() => ({ slot: 1, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' })) });
  if (m.method === 'getTransaction') return { jsonrpc: '2.0', id: m.id, error: { code: -32004, message: 'mock: not kept' } };
  const r = await fetch(REAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) });
  return r.json();
};
const rpc = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const msg = JSON.parse(body);
  const out = Array.isArray(msg) ? await Promise.all(msg.map(answer)) : await answer(msg);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
}).listen(PORT);
// web3.js confirms over a websocket on port + 1: confirm every signature at once
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
Object.assign(process.env, { AUTH_SECRET: 'test-secret', GIVEAWAY_SECRET: b58(giver.secretKey), MAINNET_RPC_URL: `http://127.0.0.1:${PORT}`,
  GIVEAWAY_CHANCE: '1', GIVEAWAY_DAILY_USD: '25', GIVEAWAY_PER_IP: '2', SOLANA_NETWORK: 'devnet' });
const handler = (await import('./api/laundry.js')).default;
const mac = (s) => crypto.createHmac('sha256', 'test-secret').update(s).digest('base64url');
const session = (owner) => { const p = Buffer.from(JSON.stringify({ owner, exp: Date.now() + 36e5 })).toString('base64url'); return p + '.' + mac('s:' + p); };
const ticket = (t) => { const p = Buffer.from(JSON.stringify(t)).toString('base64url'); return p + '.' + mac('gift:' + p); };
async function call(q, { owner, body, ip = '1.1.1.1' } = {}) {
  const req = { method: 'POST', query: { q }, body: body || {}, headers: { 'x-forwarded-for': ip, ...(owner ? { authorization: 'Bearer ' + session(owner) } : {}) } };
  return new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { resolve({ code: this.code, ...d }); }, send() { resolve({ code: this.code }); }, end() { resolve({ code: this.code }); } };
    handler(req, res);
  });
}
const today = new Date().toISOString().slice(0, 10);
const ledger = () => blob.read('laundry/ledger.json');
const wallet = () => web3.Keypair.generate().publicKey.toBase58();
const [A, B, C, D] = [wallet(), wallet(), wallet(), wallet()];
blob.seed('laundry/ledger.json', { wallets: {}, mints: {} });
let pass = 0, fail = 0;
const check = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

// the draw
const d1 = await call('bubble', { owner: A });
check('draw wins at chance 1 and signs a ticket', d1.win === true && typeof d1.ticket === 'string' && d1.usd >= 1 && d1.usd <= 10, `$${d1.usd} ${d1.coin && d1.coin.symbol}`);
const fresh = (c = 200, key = 'bonk') => ticket({ c, k: key, x: Date.now() + 60e3, n: crypto.randomBytes(9).toString('base64url') });

// refusals before anything happens
check('no session is refused', (await call('gift', { body: { ticket: fresh() } })).code === 401);
check('forged ticket is refused', (await call('gift', { owner: A, body: { ticket: fresh().slice(0, -3) + 'abc' } })).code === 400);
check('expired ticket is refused', /dried up/.test((await call('gift', { owner: A, body: { ticket: ticket({ c: 200, k: 'bonk', x: Date.now() - 1, n: 'old' }) } })).error));
check('ticket over $10 is refused', (await call('gift', { owner: A, body: { ticket: fresh(5000) } })).code === 400);

// a send that never reaches the network is taken back out of the ledger
SEND.mode = 'fail';
const tA = fresh(200, 'wif');
const f1 = await call('gift', { owner: A, body: { ticket: tA } });
const L1 = ledger(), day1 = L1.giveaway.days[today];
check('failed send says try again', f1.code === 502, f1.error);
check('failed send leaves nothing spent', day1.used.length === 0 && day1.usd === 0 && day1.wins === 0 && !L1.wallets[A].giftDay && L1.giveaway.log[0].state === 'failed');

// the same ticket then goes through
SEND.mode = 'ok';
const s1 = await call('gift', { owner: A, body: { ticket: tA } });
const L2 = ledger(), day2 = L2.giveaway.days[today];
check('claim sends and reports it', s1.code === 200 && s1.sent === true && /solscan\.io\/tx\//.test(s1.explorer), `out ${s1.out} ${s1.coin && s1.coin.symbol}`);
check('ledger records the prize', day2.used.length === 1 && day2.usd === 2 && day2.wins === 1 && L2.wallets[A].giftDay === today && L2.giveaway.log[0].state === 'done' && L2.giveaway.log[0].signature);

// every rule after that
check('same ticket twice is refused', (await call('gift', { owner: A, body: { ticket: tA } })).code === 409);
check('same wallet twice a day is refused', /already took/.test((await call('gift', { owner: A, body: { ticket: fresh() } })).error));
check('signed-in winner of today draws no more wins', (await call('bubble', { owner: A, ip: '9.9.9.9' })).win === false);
const s2 = await call('gift', { owner: B, body: { ticket: fresh(250, 'pump') } });
check('second wallet on the same connection is fine', s2.code === 200 && s2.sent, `out ${s2.out} PUMP`);
check('third wallet on that connection is refused', /this connection/.test((await call('gift', { owner: C, body: { ticket: fresh() } })).error));
check('that connection draws no more wins', (await call('bubble', { ip: '1.1.1.1' })).win === false);
const L3 = ledger(); L3.giveaway.days[today].usd = 24; blob.seed('laundry/ledger.json', L3);
check('prize past the daily budget is refused', /all gone/.test((await call('gift', { owner: D, ip: '2.2.2.2', body: { ticket: fresh(200) } })).error));
check('an in-budget prize still goes through', (await call('gift', { owner: D, ip: '2.2.2.2', body: { ticket: fresh(100, 'mew') } })).sent === true);
check('sends made', SEND.count === 4, `count ${SEND.count}`);
console.log(`${pass} passed, ${fail} failed`);
rpc.close(); wss.close(); process.exit(fail ? 1 : 0);
