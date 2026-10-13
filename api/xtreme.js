// Xtreme (beta): a 2x long on BTC, SOL or ETH for 1, 2 or 3 months, closed by
// itself at the end. The rules and the why are in xtreme-core.js.
//
//   GET  ?q=info                 markets, prices and costs (anyone)
//   GET  ?q=mine                 the signed-in wallet's Xtreme trades and closing days
//   POST ?q=open {coin, sol}     the trade, built by Jupiter for this wallet (unsigned)
//   POST ?q=relay {signed, action}  a signed trade or close, handed to Jupiter's keeper
//   POST ?q=schedule {coin, months} the close made in advance, for the wallet to sign (not send)
//   POST ?q=arm {id, signed}     keeps that signed close until its day
//   POST ?q=close {coin}         closes a trade now (unsigned, for the wallet)
//   GET  ?q=sweep                (cron) sends closes that are due and tidies up
//
// The laundry takes no fee on Xtreme and gives no prize for it.

import crypto from 'crypto';
import { put, head, get } from '@vercel/blob';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, VersionedTransaction, NONCE_ACCOUNT_LENGTH } from '@solana/web3.js';
import { X_LEVERAGE, X_CYCLES, X_MARKETS, PERPS, JLP_POOL, USDC_MINT, X_MIN_SOL, X_KEEP_SOL, X_SLIPPAGE_BPS, dueAt, yearly } from '../xtreme-core.js';

const AUTH_SECRET = process.env.AUTH_SECRET || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const NETWORK = process.env.SOLANA_NETWORK || 'devnet';
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const RPC = String(process.env.MAINNET_RPC_URL || '').trim() || PUBLIC_RPC;
const JAPI = 'https://perps-api.jup.ag/v1';
const KEY = 'laundry/xtreme.json';
const LAMPORTS = 1e9;
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const isAddr = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || ''));

// ---------------- base58, and the laundry's wallet (the nonce accounts' owner) ----------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  const bytes = [0];
  for (const ch of String(str)) {
    const v = B58.indexOf(ch); if (v < 0) return null;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of String(str)) { if (ch === '1') bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}
const b58 = (bytes) => { const d = [0]; for (const b of bytes) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let o = ''; for (const b of bytes) { if (b === 0) o += '1'; else break; } return o + d.reverse().map((x) => B58[x]).join(''); };
let HOUSE_KP;
function house() {
  if (HOUSE_KP !== undefined) return HOUSE_KP;
  const s = String(process.env.LAUNDRY_SECRET || '').trim();
  try { HOUSE_KP = s ? Keypair.fromSecretKey(b58decode(s)) : null; } catch { HOUSE_KP = null; }
  return HOUSE_KP;
}

// ---------------- connections ----------------
// Reads move on to the public node when the paid one turns them away or fails;
// a send moves on only when it was turned away at the door.
async function steadyFetch(_url, init = {}) {
  const send = /"method"\s*:\s*"sendTransaction"/.test(typeof init.body === 'string' ? init.body : '');
  let last;
  for (const u of [...new Set([RPC, PUBLIC_RPC])]) {
    try {
      const r = await fetch(u, { ...init, signal: AbortSignal.timeout(15000) });
      if (send ? [401, 402, 403, 429].includes(r.status) : (r.status === 429 || r.status >= 500 || [401, 402, 403].includes(r.status))) { last = r; continue; }
      return r;
    } catch (e) { if (send) throw e; last = e; }
  }
  if (last && typeof last.status === 'number') return last;
  throw last || new Error('no node');
}
let CONN = null;
const conn = () => (CONN ??= new Connection(RPC, { commitment: 'confirmed', fetch: steadyFetch, disableRetryOnRateLimit: true }));
async function japi(path, body) {
  const r = await fetch(JAPI + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) } : { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.error || 'perps api ' + r.status), { status: r.status, body: j });
  return j;
}

// ---------------- session and limits ----------------
const mac = (s) => crypto.createHmac('sha256', AUTH_SECRET).update(s).digest('base64url');
function safeEq(a, b) { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); }
function ownerFromSession(req) {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const [payload, tag] = t.split('.');
  if (!payload || !tag || !AUTH_SECRET || !safeEq(tag, mac('s:' + payload))) return null;
  try { const d = JSON.parse(Buffer.from(payload, 'base64url').toString()); return (d.exp && d.exp > Date.now()) ? d.owner : null; } catch { return null; }
}
const HITS = new Map();
function slowDown(key, max = 20) {
  const now = Date.now(), list = (HITS.get(key) || []).filter((t) => now - t < 60e3);
  if (list.length >= max) return true;
  list.push(now); HITS.set(key, list);
  if (HITS.size > 20000) HITS.clear();
  return false;
}
const kept = new Map();
async function cached(key, ms, fn) {
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v;
  const v = await fn();
  kept.set(key, { at: Date.now(), v });
  return v;
}

// ---------------- the store: closes kept until their day ----------------
async function readStore() {
  const r = await get(KEY, { access: 'private', useCache: false, abortSignal: AbortSignal.timeout(8000) });
  if (!r) return null;
  const text = await new Response(r.stream).text();
  const tag = String((r.blob && r.blob.etag) || '').replace(/^W\//, '') || (await head(KEY)).etag;
  return { store: JSON.parse(text), tag };
}
async function loadStore() {
  let got = await readStore();
  if (!got) {
    try { await put(KEY, JSON.stringify({ items: {} }), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 0 }); } catch {}
    got = await readStore();
    if (!got) throw new Error('The Xtreme store could not be read.');
  }
  return { store: Object.assign({ items: {} }, got.store), tag: got.tag };
}
// fn changes the store and returns true to write it (false: nothing to write). null: it kept losing its race.
async function patchStore(fn) {
  for (let i = 0; i < 6; i++) {
    try {
      const { store, tag } = await loadStore();
      if (!fn(store)) return false;
      await put(KEY, JSON.stringify(store), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0, ifMatch: tag });
      return true;
    } catch { await new Promise((w) => setTimeout(w, 80 + Math.random() * 250 * (i + 1))); }
  }
  return null;
}

// ---------------- Jupiter's accounts ----------------
const PERPS_ID = new PublicKey(PERPS);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PERPS_ID)[0];
const PERPETUALS = pda([Buffer.from('perpetuals')]);
const EVENT_AUTHORITY = pda([Buffer.from('__event_authority')]);
// A wallet's long on a coin: one account per wallet, coin and side, so one Xtreme per coin at a time.
export const positionPda = (owner, custody) => pda([Buffer.from('position'), new PublicKey(owner).toBuffer(), new PublicKey(JLP_POOL).toBuffer(), new PublicKey(custody).toBuffer(), new PublicKey(custody).toBuffer(), Buffer.from([1])]).toBase58();
const ata = (mint, owner) => PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(TOKEN).toBuffer(), mint.toBuffer()], new PublicKey(ATA_PROGRAM))[0];
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const DISC_DECREASE = crypto.createHash('sha256').update('global:create_decrease_position_market_request').digest().subarray(0, 8);
// The close request: the whole position, at whatever the price is then (a long's
// lowest price bound is 0), paid out in USDC to the owner's own USDC account.
export function closeRequestIx(owner, custody, counter) {
  const me = new PublicKey(owner), cust = new PublicKey(custody), usdc = new PublicKey(USDC_MINT);
  const position = new PublicKey(positionPda(owner, custody));
  const request = pda([Buffer.from('position_request'), position.toBuffer(), u64(counter), Buffer.from([2])]);
  const data = Buffer.concat([DISC_DECREASE, u64(0), u64(0), u64(0), Buffer.from([0]), Buffer.from([1, 1]), u64(counter)]);
  const k = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  return new TransactionInstruction({ programId: PERPS_ID, data, keys: [
    k(me, true, true), k(ata(usdc, me), true), k(PERPETUALS), k(new PublicKey(JLP_POOL)), k(position), k(request, true), k(ata(usdc, request), true),
    k(cust), k(cust), k(usdc), k(PERPS_ID), k(new PublicKey(TOKEN)), k(new PublicKey(ATA_PROGRAM)), k(SystemProgram.programId), k(EVENT_AUTHORITY), k(PERPS_ID),
  ] });
}
// The owner's USDC account, made if it isn't there (the close pays out into it).
const usdcAccountIx = (owner) => {
  const me = new PublicKey(owner), usdc = new PublicKey(USDC_MINT);
  return new TransactionInstruction({ programId: new PublicKey(ATA_PROGRAM), data: Buffer.from([1]), keys: [
    { pubkey: me, isSigner: true, isWritable: true }, { pubkey: ata(usdc, me), isSigner: false, isWritable: true }, { pubkey: me, isSigner: false, isWritable: false },
    { pubkey: usdc, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: new PublicKey(TOKEN), isSigner: false, isWritable: false },
  ] });
};
// The closing transaction, tied to a nonce of the laundry's: it never runs out,
// the owner pays its small fee and deposit when it's sent, and the laundry's
// wallet signs only the nonce's part, on the day.
export function closeTx(owner, custody, nonceKey, nonceValue, houseKey) {
  const counter = BigInt('0x' + crypto.randomBytes(8).toString('hex')) & ((1n << 63n) - 1n);
  const tx = new Transaction({ feePayer: new PublicKey(owner), nonceInfo: { nonce: nonceValue, nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: new PublicKey(nonceKey), authorizedPubkey: new PublicKey(houseKey) }) } });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), usdcAccountIx(owner), closeRequestIx(owner, custody, counter));
  const message = tx.serializeMessage();
  return { b64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), hash: crypto.createHash('sha256').update(message).digest('hex') };
}

// Jupiter's own transactions (trade and close now): paid by this wallet, and only Jupiter's programs.
// Some markets (SOL, 2026-10-12) post a signed price in the same transaction: Jupiter's price
// program (Doves) and Solana's built-in signature check come along.
const INSTANT_PROGRAMS = new Set(['ComputeBudget111111111111111111111111111111', ATA_PROGRAM, '11111111111111111111111111111111', TOKEN, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', PERPS, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e', 'Ed25519SigVerify111111111111111111111111111']);
export function checkInstant(b64, owner) {
  try {
    const m = VersionedTransaction.deserialize(Buffer.from(String(b64 || ''), 'base64')).message;
    if (m.staticAccountKeys[0].toBase58() !== owner) return 'That isn’t this wallet’s trade.';
    if (m.compiledInstructions.some((i) => !INSTANT_PROGRAMS.has(m.staticAccountKeys[i.programIdIndex].toBase58()))) return 'That trade didn’t look right. Nothing was sent.';
    return null;
  } catch { return 'That isn’t a transaction.'; }
}
const sigOf = (b64) => { const raw = Buffer.from(b64, 'base64'); return b58(raw.subarray(1, 65)); };
// Plain words for Jupiter's refusals.
const plain = (e) => {
  const m = String((e && (e.message || (e.body && e.body.message))) || e || '');
  if (/insufficient|not enough|balance/i.test(m)) return 'Not enough SOL for that.';
  if (/too small|minimum/i.test(m)) return 'That’s too small for a trade. Try a bit more.';
  if (/slippage|price/i.test(m)) return 'The price moved. Try again.';
  return 'Couldn’t do that right now. Try again in a minute.';
};

// ---------------- reads ----------------
async function info() {
  return cached('xinfo', 60e3, async () => {
    const markets = [];
    for (const m of X_MARKETS) {
      const [pool, stats] = await Promise.all([japi('/pool-info?mint=' + m.mint), japi('/market-stats?mint=' + m.mint)]);
      markets.push({ sym: m.sym, price: Number(stats.price) || null, borrowYear: yearly(pool.longBorrowRatePercent), openFeePct: Number(pool.openFeePercent) || 0 });
    }
    return { on: true, beta: true, leverage: X_LEVERAGE, cycles: X_CYCLES, markets, minSol: X_MIN_SOL, keepSol: X_KEEP_SOL, autoClose: Boolean(house()) };
  });
}
// The wallet's open longs on Jupiter (any opened here or not), in plain numbers.
async function positionsOf(owner) {
  const d = await japi('/positions?walletAddress=' + owner);
  return (d.dataList || []).filter((p) => p.side === 'long').map((p) => {
    const m = X_MARKETS.find((x) => x.mint === p.marketMint);
    return { position: p.positionPubkey, sym: m ? m.sym : '?', sizeUsd: Number(p.size) || 0, value: Number(p.value) || 0, entry: Number(p.entryPrice) || 0,
      mark: Number(p.markPrice) || 0, wipeout: Number(p.liquidationPrice) || 0, pnl: Number(p.pnlAfterFeesUsd) || 0, leverage: Number(p.leverage) || 0, opened: (Number(p.createdTime) || 0) * 1000 };
  });
}

// ---------------- the trade ----------------
async function buildOpen(owner, b) {
  const m = X_MARKETS.find((x) => x.sym === b.coin);
  if (!m) return { error: 'Pick a coin.' };
  const sol = Number(b.sol);
  if (!(sol >= X_MIN_SOL)) return { error: `Put in at least ${X_MIN_SOL} SOL.` };
  const lamports = Math.round(sol * LAMPORTS);
  if ((await positionsOf(owner)).some((p) => p.sym === m.sym)) return { error: `You already have a trade on ${m.sym}. Close it first, or wait for its closing day.` };
  const bal = await conn().getBalance(new PublicKey(owner));
  if (bal < lamports + Math.round((X_KEEP_SOL + 0.01) * LAMPORTS)) return { error: `Not enough SOL. Keep about ${X_KEEP_SOL} SOL in your wallet for the close later.` };
  let j;
  // (Jupiter's v1 names: the market's and collateral's mints; for a long the coin is its own collateral)
  try { j = await japi('/positions/increase', { walletAddress: owner, marketMint: m.mint, collateralMint: m.mint, inputMint: 'So11111111111111111111111111111111111111112', collateralTokenDelta: String(lamports), leverage: String(X_LEVERAGE), maxSlippageBps: String(X_SLIPPAGE_BPS), side: 'long' }); }
  catch (e) { console.warn('xtreme: open refused', String(e.message).slice(0, 160)); return { error: plain(e) }; }
  if (!j.serializedTxBase64) return { error: 'Couldn’t build that trade right now. Try again.' };
  const bad = checkInstant(j.serializedTxBase64, owner);
  if (bad) return { error: bad };
  if (j.positionPubkey !== positionPda(owner, m.custody)) return { error: 'That trade didn’t look right. Nothing was sent.' };
  const q = j.quote || {};
  return { tx: j.serializedTxBase64, position: j.positionPubkey, until: j.txMetadata ? j.txMetadata.lastValidBlockHeight : null,
    quote: { entry: Number(q.entryPriceUsd) || null, wipeout: Number(q.liquidationPriceUsd) || null, sizeUsd: Number(q.positionSizeUsd) || null, inUsd: Number(q.positionCollateralSizeUsd) || null, feesUsd: (Number(q.openFeeUsd) || 0) + (Number(q.priceImpactFeeUsd) || 0) } };
}
async function buildCloseNow(owner, b) {
  const m = X_MARKETS.find((x) => x.sym === b.coin);
  if (!m) return { error: 'Pick a coin.' };
  const position = positionPda(owner, m.custody);
  if (!(await positionsOf(owner)).some((p) => p.position === position)) return { error: 'No open trade on that coin.' };
  let j;
  try { j = await japi('/positions/decrease', { positionPubkey: position, desiredMint: USDC_MINT, collateralUsdDelta: '0', sizeUsdDelta: '0', entirePosition: true, maxSlippageBps: String(X_SLIPPAGE_BPS) }); }
  catch (e) { console.warn('xtreme: close refused', String(e.message).slice(0, 160)); return { error: plain(e) }; }
  if (!j.serializedTxBase64) return { error: 'Couldn’t build the close right now. Try again.' };
  const bad = checkInstant(j.serializedTxBase64, owner);
  if (bad) return { error: bad };
  return { tx: j.serializedTxBase64, until: j.txMetadata ? j.txMetadata.lastValidBlockHeight : null };
}
// A signed trade or close goes to Jupiter, whose keeper adds its signature and sends it.
async function relay(owner, signed, action) {
  if (!['increase-position', 'decrease-position'].includes(action)) return { status: 400, body: { error: 'Unknown' } };
  const bad = checkInstant(signed, owner);
  if (bad) return { status: 400, body: { error: bad } };
  const sig = sigOf(signed);
  let r, j = {};
  try {
    r = await fetch(JAPI + '/transaction/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, serializedTxBase64: signed }), signal: AbortSignal.timeout(40000) });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    // no answer: it may have gone out, so the page watches the signature
    console.warn('xtreme: execute unclear', String(e && e.message).slice(0, 120));
    return { status: 200, body: { signature: sig, unsure: true } };
  }
  if (r.ok && j.txid) return { status: 200, body: { signature: j.txid } };
  console.warn('xtreme: execute refused', r.status, JSON.stringify(j).slice(0, 200));
  if (r.status >= 500) return { status: 200, body: { signature: sig, unsure: true } };
  return { status: 409, body: { error: plain(j) + ' Nothing moved.' } };
}

// ---------------- the close, made in advance ----------------
async function newNonce(houseKp) {
  const seed = 'x' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const nonce = await PublicKey.createWithSeed(houseKp.publicKey, seed, SystemProgram.programId);
  const rent = await conn().getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const tx = new Transaction().add(SystemProgram.createNonceAccount({ fromPubkey: houseKp.publicKey, noncePubkey: nonce, basePubkey: houseKp.publicKey, seed, authorizedPubkey: houseKp.publicKey, lamports: rent }));
  const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash; tx.feePayer = houseKp.publicKey; tx.sign(houseKp);
  const sig = await conn().sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  await conn().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return { nonce: nonce.toBase58(), seed };
}
async function schedule(owner, b) {
  const hk = house();
  if (!hk) return { error: 'Auto close isn’t set up here.' };
  const m = X_MARKETS.find((x) => x.sym === b.coin);
  const months = Number(b.months);
  if (!m || !X_CYCLES.includes(months)) return { error: 'Pick a coin and how long.' };
  const position = positionPda(owner, m.custody);
  if (!(await positionsOf(owner)).some((p) => p.position === position)) return { error: 'The trade isn’t showing yet. Give it a moment and try again.' };
  const { store } = await loadStore();
  const live = Object.values(store.items).find((x) => x.position === position && (x.state === 'armed' || x.state === 'sent'));
  if (live) return { error: 'Auto close is already on for this trade.' };
  let item = Object.values(store.items).find((x) => x.position === position && x.owner === owner && x.state === 'pending');
  if (!item) {
    const n = await newNonce(hk);
    item = { id: crypto.randomBytes(9).toString('base64url'), owner, position, coin: m.sym, nonce: n.nonce, seed: n.seed, state: 'pending', at: Date.now() };
  }
  const nv = await conn().getNonce(new PublicKey(item.nonce), 'confirmed');
  if (!nv) return { error: 'Couldn’t set up the auto close. Try again.' };
  const built = closeTx(owner, m.custody, item.nonce, nv.nonce, hk.publicKey.toBase58());
  Object.assign(item, { months, dueAt: dueAt(Date.now(), months), hash: built.hash });
  const ok = await patchStore((s) => { s.items[item.id] = { ...(s.items[item.id] || {}), ...item }; return true; });
  if (ok === null) return { error: 'Busy. Try again.' };
  return { id: item.id, tx: built.b64, dueAt: item.dueAt };
}
// The wallet's own signature on exactly the closing transaction made above.
function signedBy(tx, owner) {
  const s = tx.signatures.find((x) => x.publicKey.toBase58() === owner);
  if (!s || !s.signature) return false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(new PublicKey(owner).toBytes()).toString('base64url') }, format: 'jwk' });
    return crypto.verify(null, tx.serializeMessage(), key, s.signature);
  } catch { return false; }
}
async function arm(owner, id, signed) {
  let tx;
  try { tx = Transaction.from(Buffer.from(String(signed || ''), 'base64')); } catch { return { status: 400, body: { error: 'That isn’t a transaction.' } }; }
  const hash = crypto.createHash('sha256').update(tx.serializeMessage()).digest('hex');
  let out = null;
  const ok = await patchStore((s) => {
    const it = s.items[id];
    if (!it || it.owner !== owner || it.state !== 'pending') { out = { status: 400, body: { error: 'That close isn’t waiting to be signed. Try again.' } }; return false; }
    if (it.hash !== hash) { out = { status: 400, body: { error: 'Your wallet changed the closing transaction, so it can’t be kept. Try again.' } }; return false; }
    if (!signedBy(tx, owner)) { out = { status: 400, body: { error: 'That isn’t signed by this wallet.' } }; return false; }
    Object.assign(it, { signed: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), state: 'armed', armedAt: Date.now() });
    out = { status: 200, body: { ok: true, dueAt: it.dueAt } };
    return true;
  });
  if (ok === null) return { status: 503, body: { error: 'Busy. Try again.' } };
  return out;
}

// ---------------- the sweep: closes that are due, and tidying up ----------------
async function reclaim(hk, it) {
  // the nonce's deposit back to the laundry; it also makes the old signed close useless
  const key = new PublicKey(it.nonce);
  const bal = await conn().getBalance(key);
  if (bal > 0) {
    const tx = new Transaction().add(SystemProgram.nonceWithdraw({ noncePubkey: key, authorizedPubkey: hk.publicKey, toPubkey: hk.publicKey, lamports: bal }));
    const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash; tx.feePayer = hk.publicKey; tx.sign(hk);
    const sig = await conn().sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
    await conn().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  }
  return true;
}
async function sweep() {
  const hk = house();
  if (!hk) return { skipped: 'no house key' };
  const { store } = await loadStore();
  const now = Date.now(), changes = {}, log = [];
  const openOf = new Map();
  const isOpen = async (it) => {
    if (!openOf.has(it.owner)) openOf.set(it.owner, await positionsOf(it.owner).catch(() => null));
    const list = openOf.get(it.owner);
    return list === null ? null : list.some((p) => p.position === it.position);
  };
  for (const it of Object.values(store.items)) {
    const set = (patch) => { changes[it.id] = { ...(changes[it.id] || {}), ...patch }; Object.assign(it, patch); };
    try {
      if (it.state === 'armed' && now >= it.dueAt) {
        const open = await isOpen(it);
        if (open === false) { set({ state: 'done', note: 'closed before its day' }); }
        else if (open) {
          const tx = Transaction.from(Buffer.from(it.signed, 'base64'));
          tx.partialSign(hk);
          try {
            const sig = await conn().sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
            set({ state: 'sent', sig, sentAt: now }); log.push('sent ' + it.id);
          } catch (e) {
            const tries = (it.tries || 0) + 1;
            set({ tries, lastError: String(e && e.message).slice(0, 160), ...(tries >= 3 ? { state: 'failed' } : {}) }); log.push('send failed ' + it.id);
          }
        }
      } else if (it.state === 'sent' && now - it.sentAt > 3 * 60e3) {
        const open = await isOpen(it);
        if (open === false) set({ state: 'done' });
        else if (open && now - it.sentAt > 30 * 60e3) set({ state: 'failed', lastError: 'still open after the close was sent' });
      } else if (it.state === 'pending' && now - it.at > 2 * 3600e3) {
        set({ state: 'dropped' });
      }
      if (['done', 'failed', 'dropped'].includes(it.state) && !it.reclaimed) { await reclaim(hk, it); set({ reclaimed: true, signed: null }); }
    } catch (e) { log.push('error ' + it.id + ' ' + String(e && e.message).slice(0, 80)); }
  }
  if (Object.keys(changes).length) {
    await patchStore((s) => { for (const [id, p] of Object.entries(changes)) if (s.items[id]) Object.assign(s.items[id], p); return true; });
  }
  return { changed: Object.keys(changes).length, log };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = String(req.query.q || '');
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  try {
    if (NETWORK !== 'mainnet' && !process.env.DRYER_ANY_NETWORK) return res.status(200).json({ on: false });
    if (q === 'info') return res.status(200).json(await info());
    if (q === 'sweep') {
      if (!CRON_SECRET || !safeEq(String(req.headers.authorization || ''), 'Bearer ' + CRON_SECRET)) return res.status(401).json({ error: 'Not allowed' });
      return res.status(200).json(await sweep());
    }
    const owner = ownerFromSession(req);
    if (!owner) return res.status(401).json({ error: 'Connect your wallet first.' });
    if (q === 'mine') {
      if (slowDown('mine:' + owner, 30)) return res.status(429).json({ error: 'Slow down a moment.' });
      const [positions, st] = await Promise.all([positionsOf(owner).catch(() => null), loadStore().catch(() => null)]);
      const closes = st ? Object.values(st.store.items).filter((x) => x.owner === owner && ['pending', 'armed', 'sent', 'failed'].includes(x.state))
        .map((x) => ({ id: x.id, position: x.position, coin: x.coin, state: x.state, dueAt: x.dueAt, months: x.months })) : null;
      return res.status(200).json({ positions, closes, unread: positions === null });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
    if (slowDown('x:' + owner)) return res.status(429).json({ error: 'Slow down a moment, then try again.' });
    if (q === 'open') { const r = await buildOpen(owner, body); return res.status(r.tx ? 200 : 400).json(r); }
    if (q === 'close') { const r = await buildCloseNow(owner, body); return res.status(r.tx ? 200 : 400).json(r); }
    if (q === 'relay') { const r = await relay(owner, body.signed, String(body.action || '')); return res.status(r.status).json(r.body); }
    if (q === 'schedule') { const r = await schedule(owner, body); return res.status(r.tx ? 200 : 400).json(r); }
    if (q === 'arm') { const r = await arm(owner, String(body.id || ''), body.signed); return res.status(r.status).json(r.body); }
    return res.status(404).json({ error: 'Unknown' });
  } catch (e) {
    const msg = String((e && e.stack) || e);
    console.error('xtreme:', q, msg.slice(0, 400));
    if (/\b429\b|Too Many Requests|timed? ?out|aborted/i.test(msg)) return res.status(503).json({ error: 'The network is busy. Try again in a minute.' });
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}
