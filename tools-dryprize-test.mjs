// The dryer's prizes, end to end without moving anything: the dryer's real
// ticket, the laundry's real handler on an in-memory ledger, and a stand-in
// Solana node that answers getTransaction with the transactions below.
// Run: node --import ./tools-dev-register.mjs tools-dryprize-test.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as blob from './tools-dev-blob-stub.mjs';

const PORT = 18931;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => { const d = [0]; for (const b of bytes) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let o = ''; for (const b of bytes) { if (b === 0) o += '1'; else break; } return o + d.reverse().map((x) => B58[x]).join(''); };
const newSig = () => b58(crypto.randomBytes(64));
const newHash = () => b58(crypto.randomBytes(32));
const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';

// ---- the stand-in node: sig -> transaction, as jsonParsed getTransaction answers ----
const CHAIN = new Map();
const rpc = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const m = JSON.parse(body);
  const result = m.method === 'getTransaction' ? CHAIN.get(m.params[0]) || null : null;
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
}).listen(PORT);
const txOf = ({ payer, bh, err = null, ixs = [], logs = [] }) => ({ slot: 1, meta: { err, logMessages: logs }, transaction: { message: { accountKeys: [{ pubkey: payer, signer: true, writable: true }], recentBlockhash: bh, instructions: ixs } } });
const delegate = (by) => ({ program: 'stake', programId: 'Stake11111111111111111111111111111111111111', parsed: { type: 'delegate', info: { stakeAccount: Keypair.generate().publicKey.toBase58(), voteAccount: Keypair.generate().publicKey.toBase58(), stakeAuthority: by } } });
const borrowLogs = ['Program ' + KLEND + ' invoke [1]', 'Program log: Instruction: BorrowObligationLiquidityV2', 'Program ' + KLEND + ' success'];

// ---- the handlers, with this test's settings ----
Object.assign(process.env, { LAUNDRY_NEW_WALLETS_PER_IP: '1000', AUTH_SECRET: 'test-secret', MAINNET_RPC_URL: `http://127.0.0.1:${PORT}`, SOLANA_NETWORK: 'devnet' });
const handler = (await import('./api/laundry.js')).default;
const { prizeTicket, blockhashOf } = await import('./api/dryer.js');
const mac = (s) => crypto.createHmac('sha256', 'test-secret').update(s).digest('base64url');
const session = (owner) => { const p = Buffer.from(JSON.stringify({ owner, exp: Date.now() + 36e5 })).toString('base64url'); return p + '.' + mac('s:' + p); };
async function call(q, { owner, body, method = 'POST' } = {}) {
  const req = { method, query: { q }, body: body || {}, headers: { 'x-forwarded-for': '1.1.1.1', ...(owner ? { authorization: 'Bearer ' + session(owner) } : {}) } };
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, setHeader() {}, json(d) { resolve({ code: this.code, ...d }); return this; }, end() { resolve({ code: this.code }); return this; } };
    handler(req, res);
  });
}
// a transaction the dryer built for `owner`, and its ticket
const built = (owner, op) => {
  const bh = newHash();
  const tx = new Transaction({ feePayer: new PublicKey(owner), recentBlockhash: bh }).add(SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  return { bh, ticket: prizeTicket(owner, op, tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')) };
};
const wallet = (owner) => blob.read('laundry/ledger.json').wallets[owner] || {};

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };

// ---- the ticket names the transaction's blockhash, legacy or v0 ----
{
  const payer = Keypair.generate().publicKey, bh = newHash();
  const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const legacy = new Transaction({ feePayer: payer, recentBlockhash: bh }).add(ix).serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const v0 = Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: bh, instructions: [ix] }).compileToV0Message()).serialize()).toString('base64');
  ok(blockhashOf(legacy) === bh && blockhashOf(v0) === bh, 'blockhash read from a legacy and a v0 transaction');
  const [p, tag] = prizeTicket(payer.toBase58(), 'boost', v0).split('.');
  const t = JSON.parse(Buffer.from(p, 'base64url').toString());
  ok(tag === mac('dry:' + p) && t.o === payer.toBase58() && t.op === 'boost' && t.bh === bh, 'the ticket is signed and names the wallet, the setting and the blockhash');
}

// ---- a stake pays once ----
const A = Keypair.generate().publicKey.toBase58(), B = Keypair.generate().publicKey.toBase58();
ok((await call('dryprize', { body: {} })).code === 401, 'no session is refused');
await call('pops', { owner: A, method: 'GET' });                    // signed in: the page's first visit sets the round's 200
ok(wallet(A).pops === 200, 'starts with the round’s 200 bubbles');
const s1 = built(A, 'stake'), sig1 = newSig();
CHAIN.set(sig1, txOf({ payer: A, bh: s1.bh, ixs: [delegate(A)] }));
const r1 = await call('dryprize', { owner: A, body: { sig: sig1, ticket: s1.ticket } });
ok(r1.code === 200 && [100, 150, 200, 250].includes(r1.bubbles) && (r1.socks === 1 || r1.socks === 2), 'a stake pays bubbles and a sock or two: ' + JSON.stringify(r1));
ok(wallet(A).pops === 200 + r1.bubbles && wallet(A).socks === r1.socks && r1.left === 2 && !r1.starter, 'the ledger has them, two more today');
const again = await call('dryprize', { owner: A, body: { sig: sig1, ticket: s1.ticket } });
ok(again.code === 200 && again.again && wallet(A).pops === 200 + r1.bubbles, 'asking again shows the same prize and pays nothing more');
const twin = newSig();
CHAIN.set(twin, txOf({ payer: A, bh: s1.bh, ixs: [delegate(A)] }));
ok((await call('dryprize', { owner: A, body: { sig: twin, ticket: s1.ticket } })).code === 400 && wallet(A).pops === 200 + r1.bubbles, 'one ticket pays once, even for another transaction with its blockhash');
const pops = await call('pops', { owner: A, method: 'GET' });
ok(pops.socks === r1.socks, 'the menu count of socks comes with the bubbles');

// ---- what doesn't pay ----
const refused = async (what, owner, ticket, tx, code = 400) => {
  const sig = newSig(); if (tx) CHAIN.set(sig, tx);
  const before = wallet(owner).pops || 0;
  const r = await call('dryprize', { owner, body: { sig, ticket } });
  ok(r.code === code && !r.bubbles && (wallet(owner).pops || 0) === before, what + ': ' + JSON.stringify(r));
};
{ const s = built(A, 'stake'); await refused('another wallet’s ticket', B, s.ticket, txOf({ payer: B, bh: s.bh, ixs: [delegate(B)] })); }
{ const s = built(A, 'stake'); const [p] = s.ticket.split('.'); await refused('a forged ticket', A, p + '.' + mac('s:' + p), txOf({ payer: A, bh: s.bh, ixs: [delegate(A)] })); }
{
  const bh = newHash(), p = Buffer.from(JSON.stringify({ o: A, op: 'stake', bh, t: Date.now() - 31 * 60e3 })).toString('base64url');
  await refused('a ticket over 30 minutes old', A, p + '.' + mac('dry:' + p), txOf({ payer: A, bh, ixs: [delegate(A)] }));
}
{ const s = built(A, 'stake'); await refused('a transaction that failed', A, s.ticket, txOf({ payer: A, bh: s.bh, err: { InstructionError: [0, 'Custom'] }, ixs: [delegate(A)] })); }
{ const s = built(A, 'stake'); await refused('another wallet paid for it', A, s.ticket, txOf({ payer: B, bh: s.bh, ixs: [delegate(A)] })); }
{ const s = built(A, 'stake'); await refused('a different transaction (blockhash)', A, s.ticket, txOf({ payer: A, bh: newHash(), ixs: [delegate(A)] })); }
{ const s = built(A, 'stake'); await refused('a stake ticket on a transaction that staked nothing', A, s.ticket, txOf({ payer: A, bh: s.bh })); }
{ const s = built(A, 'borrow'); await refused('a borrow ticket on a transaction that borrowed nothing', A, s.ticket, txOf({ payer: A, bh: s.bh, logs: ['Program ' + KLEND + ' invoke [1]', 'Program log: Instruction: DepositReserveLiquidity'] })); }
{ const s = built(A, 'stake'); const r = await call('dryprize', { owner: A, body: { sig: 'not-a-signature', ticket: s.ticket } }); ok(r.code === 400 && !r.bubbles, 'a malformed signature'); }

// ---- borrow and boost, then the day's cap ----
const b1 = built(A, 'borrow'), bs = newSig();
CHAIN.set(bs, txOf({ payer: A, bh: b1.bh, logs: borrowLogs }));
const rb = await call('dryprize', { owner: A, body: { sig: bs, ticket: b1.ticket } });
ok(rb.code === 200 && rb.bubbles && rb.left === 1, 'a borrow pays');
const x1 = built(A, 'boost'), xs = newSig();
CHAIN.set(xs, txOf({ payer: A, bh: x1.bh, logs: ['Program ' + KLEND + ' invoke [1]', 'Program log: Instruction: FlashBorrowReserveLiquidity', ...borrowLogs] }));
const rx = await call('dryprize', { owner: A, body: { sig: xs, ticket: x1.ticket } });
ok(rx.code === 200 && rx.bubbles && rx.left === 0, 'a boost pays');
const had = wallet(A);
ok(had.pops === 200 + r1.bubbles + rb.bubbles + rx.bubbles && had.socks === r1.socks + rb.socks + rx.socks, 'three prizes add up');
const c1 = built(A, 'stake'), cs = newSig();
CHAIN.set(cs, txOf({ payer: A, bh: c1.bh, ixs: [delegate(A)] }));
const rc = await call('dryprize', { owner: A, body: { sig: cs, ticket: c1.ticket } });
ok(rc.code === 200 && rc.capped && wallet(A).pops === had.pops && wallet(A).socks === had.socks, 'a fourth in a day pays nothing');
ok((await call('dryprize', { owner: B, body: { sig: cs, ticket: c1.ticket } })).code === 400, 'another wallet can’t use it either');

// ---- a prize before the wallet's first visit of a round isn't wiped by the round's reset ----
{
  const C = Keypair.generate().publicKey.toBase58(), s = built(C, 'stake'), sig = newSig();
  CHAIN.set(sig, txOf({ payer: C, bh: s.bh, ixs: [delegate(C)] }));
  const r = await call('dryprize', { owner: C, body: { sig, ticket: s.ticket } });
  ok(r.code === 200 && r.starter === 200 && wallet(C).pops === 200 + r.bubbles, 'the 200 comes first, then the prize');
  const p = await call('pops', { owner: C, method: 'GET' });
  ok(p.pops === 200 + r.bubbles && !p.starter, 'the next visit keeps it');
}

// ---- not on chain yet ----
{ const s = built(B, 'stake'); const sig = newSig(); const r = await call('dryprize', { owner: B, body: { sig, ticket: s.ticket } }); ok(r.code === 409 && !wallet(B).pops, 'a transaction not on chain yet waits: ' + JSON.stringify(r)); }

console.log(`dryer prizes: ${n} checks passed`);
rpc.close();
process.exit(0);
