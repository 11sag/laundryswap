// Laundry Swap: a swap with a wash cycle.
//
// A live wash, step by step:
//   1. commit  The server picks a secret seed for the player's next wash and
//              shows only its hash.
//   2. pay     The server builds one transaction for the player's own wallet to
//              approve: the amount they typed, sent to the laundry wallet (any
//              other token is swapped to SOL on Jupiter inside the same
//              transaction), with a memo naming this wash.
//   3. wash    Once that payment is on chain, the server reads it back, checks
//              who paid, how much, and for which wash, draws the cycle from the
//              committed seed, and pays the result out of the laundry wallet in
//              the token the player picked. If the payout cannot start, the
//              payment goes back. The seed is revealed with the result.
// The odds and the draw live in laundry-core.js, which the page links as C0de,
// so the odds a player reads are the odds this file draws from.
//
// Until LAUNDRY_LIVE is '1', on mainnet, with the laundry wallet funded, every
// wash is practice: real quotes, real odds, a real draw, and nothing moves.

import crypto from 'crypto';
import { put, head, get } from '@vercel/blob';
import { CYCLES, RANGE, validRange, washCycle, seedHash, GIFT_BANDS, GIFTS, giftCents, VEND, VEND_COLLECTIONS, vendDraw } from '../laundry-core.js';
import { SOL_MINT, ATA_RENT, quotePair, prices, tokenInfo } from '../laundry-swap.js';

// The laundry's own ledger. Until 2026-09-29 it lived inside a shared one
// (stake/ledger.json), whose older code can write back stale copies of it.
const KEY = 'laundry/ledger.json', SHARED_KEY = 'stake/ledger.json';
const AUTH_SECRET = process.env.AUTH_SECRET || '';
const NETWORK = process.env.SOLANA_NETWORK || 'devnet';
// Live washes need the switch, mainnet, and the laundry wallet's key. On top of
// that the wallet must hold enough for the smallest wash (checked at most every
// 30 seconds), so funding the wallet is what opens the machine.
const LAUNDRY_SECRET = process.env.LAUNDRY_SECRET || '';
const LIVE_SWITCH = process.env.LAUNDRY_LIVE === '1' && NETWORK === 'mainnet' && Boolean(LAUNDRY_SECRET);
// The sweeper's key: Vercel's cron sends it, nothing else knows it.
const CRON_SECRET = process.env.CRON_SECRET || '';
// The giveaway pays real coins, so it always talks to mainnet.
// The Solana connection: the paid endpoint first when one is set
// (MAINNET_RPC_URL), and the free public one behind it, used whenever the first
// turns a call away, fails, or is down. A send is the exception: one that got
// an error or no answer may still have gone out, and a second node refusing it
// would read as "it never went", so a send moves on only from a node that
// turned it away at the door (busy, out of credit, a bad key: 401, 402, 403,
// 429) and otherwise leaves the outcome to be read from the chain.
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const RPCS = [...new Set([String(process.env.MAINNET_RPC_URL || '').trim(), PUBLIC_RPC].filter(Boolean))];
const MAINNET = RPCS[0];
const TURNED_AWAY = new Set([401, 402, 403, 429]);
// The logs say which connection is in use and when one turns calls away (at
// most once a minute), never its address: the paid one carries its key.
console.log('solana connection:', RPCS.length > 1 ? 'paid, public behind it' : 'public only');
let RPC_NOTED = 0;
const rpcNote = (paid, why) => {
  if (Date.now() - RPC_NOTED < 60e3) return;
  RPC_NOTED = Date.now();
  console.warn('solana connection', paid ? 'paid' : 'public', 'turned a call away:', why);
};
// Every attempt gets its own clock, so a slow first node cannot use up the
// second one's time, and a paid node that just timed out goes to the back of
// the line for a minute.
const RPC_TIMEOUT = 12000;
let PAID_DOWN_UNTIL = 0;
async function rpcFetch(url, init = {}) {
  const send = /"method"\s*:\s*"sendTransaction"/.test(typeof init.body === 'string' ? init.body : '');
  const order = RPCS.length > 1 && Date.now() < PAID_DOWN_UNTIL ? [...RPCS.slice(1), RPCS[0]] : RPCS;
  let last;
  for (const u of order) {
    const paid = RPCS.length > 1 && u === RPCS[0];
    try {
      const clock = AbortSignal.timeout(RPC_TIMEOUT);
      const r = await fetch(u, { ...init, signal: init.signal && AbortSignal.any ? AbortSignal.any([init.signal, clock]) : clock });
      if (TURNED_AWAY.has(r.status) || (!send && r.status >= 500)) { last = r; rpcNote(paid, r.status); continue; }
      return r;
    } catch (e) {
      if (paid && e && (e.name === 'TimeoutError' || e.name === 'AbortError')) PAID_DOWN_UNTIL = Date.now() + 60e3;
      if (send) throw e;
      last = e; rpcNote(paid, (e && e.name) || 'error');
    }
  }
  if (last && typeof last.status === 'number') return last;
  throw last || new Error('No Solana connection answered.');
}
const mainnetConn = (web3) => new web3.Connection(MAINNET, { commitment: 'confirmed', fetch: rpcFetch });
const LAMPORTS = 1_000_000_000;
const MIN = Math.round(Number(process.env.LAUNDRY_MIN_SOL || 0.05) * LAMPORTS);
const MAX = Math.round(Number(process.env.LAUNDRY_MAX_SOL || 0.5) * LAMPORTS);
const FLOAT = 10_000_000;           // SOL the laundry wallet keeps back for fees, never swapped away

// What the machine offers out of the box. Anything else can be searched.
const SHELF = [
  '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',   // Fartcoin
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',   // Bonk
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',   // dogwifhat
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',    // Jupiter
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // USDC
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',   // Popcat
  '3kEeXXSjPmLzuTmmTJGDCBbdB8Ng87opae5xg4iSpump',   // $HOPE
  '6XLbqz1BP2jE8KMdY4wHBSS4dBN4DcvZqFnvr2Ckpump',   // $BURP
];

// ---------------- small caches ----------------
const memo = new Map();
async function cached(key, ms, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.val;
  const val = await fn();
  memo.delete(key); memo.set(key, { at: Date.now(), val });
  if (memo.size > 1500) for (const k of [...memo.keys()].slice(0, 200)) memo.delete(k);    // oldest first
  return val;
}
const slim = (t) => ({ mint: t.id, symbol: t.symbol, name: t.name, decimals: t.decimals,
  icon: typeof t.icon === 'string' && /^https:\/\//.test(t.icon) ? t.icon : null,
  verified: Boolean(t.isVerified), liquidity: t.liquidity || null });
async function tokenByMint(mint) {
  return cached('t:' + mint, 10 * 60e3, async () => {
    const list = await tokenInfo(mint);
    const t = (Array.isArray(list) ? list : []).find((x) => x.id === mint);
    if (!t) throw new Error('Unknown token');
    return slim(t);
  });
}
const isMint = (m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(m || ''));

// ---------------- session + ledger ----------------
const mac = (s) => crypto.createHmac('sha256', AUTH_SECRET).update(s).digest('base64url');
function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function ownerFromSession(req) {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const [payload, tag] = t.split('.');
  if (!payload || !tag || !AUTH_SECRET || !safeEq(tag, mac('s:' + payload))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return (d.exp && d.exp > Date.now()) ? d.owner : null;
  } catch { return null; }
}
// Every write carries the version it was read at, so two writers conflict
// instead of one erasing the other, and a ledger that cannot be read is an
// error, never an empty ledger to write over the real one. The first request
// after the move copies the shared ledger once.
// The blob client retries a failed write ten times by default, doubling its
// wait each time; two is plenty here, since every write is tried again anyway.
process.env.VERCEL_BLOB_RETRIES = process.env.VERCEL_BLOB_RETRIES || '2';
async function readLedger(key) {
  const r = await get(key, { access: 'private', useCache: false, abortSignal: AbortSignal.timeout(8000) });
  if (!r) return null;                                              // not there
  const text = await new Response(r.stream).text();
  // get() hands back a weak tag (W/"..."), which a conditional write refuses
  const tag = String((r.blob && r.blob.etag) || '').replace(/^W\//, '') || (await head(key)).etag;
  return { store: JSON.parse(text), tag };
}
async function loadAt() {
  let got = await readLedger(KEY);
  if (!got) {
    const old = await readLedger(SHARED_KEY);
    try {
      await put(KEY, JSON.stringify(Object.assign({ wallets: {}, mints: {} }, old ? old.store : {})),
        { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 0 });
    } catch {}                                                       // another request made it first
    got = await readLedger(KEY);
    if (!got) throw new Error('The ledger could not be read.');
  }
  if (!got.tag) throw new Error('The ledger has no version.');
  return { store: Object.assign({ wallets: {}, mints: {} }, got.store), tag: got.tag };
}
async function saveAt(store, tag) {
  if (!tag) throw new Error('No version to write against.');       // never a blind write
  const r = await put(KEY, JSON.stringify(store), { access: 'private', contentType: 'application/json',
    addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0, ifMatch: tag });
  return String(r.etag || '').replace(/^W\//, '') || null;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  const bytes = [0];
  for (const ch of str) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

// The draw lives in laundry-core.js, the public file the page links to as C0de.

// ---------------- quotes ----------------
async function priceOf(mints) {
  const d = await cached('p:' + mints.join(','), 20e3, () => prices(mints));
  return (m) => (d && d[m] && Number(d[m].usdPrice)) || null;
}
// What an amount of any token is worth in lamports, so one set of limits holds
// whatever goes in the machine. A token with no price is asked what it would
// fetch in SOL instead.
async function lamportsOf(inMint, amount, decimals, px) {
  if (inMint === SOL_MINT) return Number(amount);
  const price = px || await priceOf([SOL_MINT, inMint]);
  if (price(inMint) && price(SOL_MINT)) return Number(amount) / 10 ** decimals * price(inMint) / price(SOL_MINT) * LAMPORTS;
  return Number((await quotePair(inMint, SOL_MINT, amount)).outAmount);
}
// One plain swap of `amount` base units, priced both ways.
async function describe(inMint, amount, mint) {
  const [from, tok, q, px] = await Promise.all([tokenByMint(inMint), tokenByMint(mint),
    quotePair(inMint, mint, amount), priceOf([SOL_MINT, inMint, mint])]);
  const inAmt = Number(amount) / 10 ** from.decimals;
  const out = Number(q.outAmount) / 10 ** tok.decimals;
  return {
    from, token: tok, inMint, amount: String(amount), in: inAmt,
    lamports: await lamportsOf(inMint, amount, from.decimals, px),
    outAmount: q.outAmount, out,
    inUsd: px(inMint) ? inAmt * px(inMint) : null,
    outUsd: px(mint) ? out * px(mint) : null,
    rate: out / inAmt,
    priceImpactPct: Number(q.priceImpactPct || 0) * 100,
  };
}
// The pay side of a request. Amounts travel as whole base units in a string,
// since a big balance of a 9-decimal token is past what a JS number holds
// exactly. Older pages sent lamports, which still means SOL.
function paySide(src) {
  const inMint = isMint(src.in) ? String(src.in) : SOL_MINT;
  let amount = String(src.amount ?? '');
  if (!amount && src.lamports != null) amount = String(Math.round(Number(src.lamports) || 0));
  if (!/^\d{1,30}$/.test(amount) || BigInt(amount) <= 0n) return { inMint, amount: null };
  return { inMint, amount: BigInt(amount).toString() };
}

// ---------------- what a wallet holds ----------------
// Read straight from mainnet: native SOL plus every non-empty token account,
// under both token programs. Names and icons come from Jupiter in one batch,
// and anything Jupiter does not list, or that is unverified with no price, is
// left out, which keeps spam airdrops out of the picker.
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
async function mainnetCall(method, params) {
  const r = await rpcFetch(MAINNET, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || 'rpc error');
  return d.result;
}
async function priceMany(mints) {
  const all = {};
  for (let i = 0; i < mints.length; i += 50) Object.assign(all, await prices(mints.slice(i, i + 50)).catch(() => ({})));
  return (m) => (all[m] && Number(all[m].usdPrice)) || null;
}
async function holdings(owner) {
  const [bal, ...accounts] = await Promise.all([mainnetCall('getBalance', [owner]),
    ...TOKEN_PROGRAMS.map((programId) => mainnetCall('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]).catch(() => ({ value: [] })))]);
  const held = new Map();
  let wrapped = 0n;
  for (const acc of accounts.flatMap((a) => a.value || [])) {
    const info = acc.account && acc.account.data && acc.account.data.parsed && acc.account.data.parsed.info;
    if (!info || !info.tokenAmount) continue;
    const amt = BigInt(info.tokenAmount.amount || '0');
    if (amt <= 0n) continue;
    if (info.mint === SOL_MINT) { wrapped += amt; continue; }       // wrapped SOL counts as SOL
    const cur = held.get(info.mint);
    held.set(info.mint, { amount: (cur ? cur.amount : 0n) + amt, decimals: info.tokenAmount.decimals });
  }
  const mints = [...held.keys()].slice(0, 100);
  const listed = mints.length ? await tokenInfo(mints.join(',')).catch(() => []) : [];
  const byMint = new Map((Array.isArray(listed) ? listed : []).map((t) => [t.id, t]));
  const px = await priceMany([SOL_MINT, ...mints.filter((m) => byMint.has(m))]);
  const out = [];
  const sol = (Number((bal && bal.value) || 0) + Number(wrapped)) / LAMPORTS;
  if (sol > 0) out.push({ mint: SOL_MINT, symbol: 'SOL', name: 'Solana', decimals: 9, icon: null, verified: true, liquidity: null,
    amount: sol, usd: px(SOL_MINT) ? sol * px(SOL_MINT) : null });
  for (const [mint, h] of held) {
    const t = byMint.get(mint);
    if (!t) continue;
    const amount = Number(h.amount) / 10 ** h.decimals, usd = px(mint) ? amount * px(mint) : null;
    if (!t.isVerified && !(usd >= 0.01)) continue;
    out.push({ ...slim(t), amount, usd });
  }
  out.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  return out.slice(0, 60);
}

async function hasAccount(owner, mint) {
  const web3 = await import('@solana/web3.js');
  const spl = await import('@solana/spl-token');
  const { destination } = await import('../laundry-swap.js');
  const conn = mainnetConn(web3);
  return (await destination({ conn, web3, spl, owner, mint })).exists;
}

// Token icons live on whatever host the token's creator picked, and plenty of
// those refuse to be embedded elsewhere. So the page asks for an icon by mint
// and this serves the bytes, but only if they really are a raster image: an SVG
// or anything else from a stranger's server never goes out under this domain.
const ICONS = new Map();
function rasterType(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
// The public IPFS gateways most icons point at (ipfs.io, nftstorage, dweb)
// answer 429 to anyone busy, so an IPFS icon is fetched from the gateways that
// still serve, and the original link is only the last resort.
const GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://4everland.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
function ipfsPath(u) {
  const m = String(u).match(/^ipfs:\/\/(.+)$/) || String(u).match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/);
  if (m) return m[1];
  const s = String(u).match(/^https?:\/\/([a-z0-9]{46,})\.ipfs\.[^/]+(\/.*)?$/i);
  return s ? s[1] + (s[2] || '') : null;
}
async function fetchRaster(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'image/*' } });
  if (!r.ok || !/^https:\/\//.test(r.url || url)) throw new Error('icon ' + r.status);
  if (Number(r.headers.get('content-length') || 0) > 600 * 1024) throw new Error('icon too big');
  const parts = []; let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > 600 * 1024) throw new Error('icon too big');
    parts.push(chunk);
  }
  const buf = Buffer.concat(parts.map((c) => Buffer.from(c)));
  const type = rasterType(buf);
  if (!type || buf.length > 600 * 1024) throw new Error('not a raster icon');
  return { buf, type };
}
async function iconFor(mint) {
  const hit = ICONS.get(mint);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit;
  const t = await tokenByMint(mint);
  if (!t.icon) throw new Error('no icon');
  const path = ipfsPath(t.icon);
  const tries = [...(path ? GATEWAYS.map((g) => g + path) : []), t.icon];
  let got = null;
  for (const url of tries) { try { got = await fetchRaster(url); break; } catch {} }
  if (!got) throw new Error('icon unavailable');
  const out = { ...got, at: Date.now() };
  if (ICONS.size > 80) ICONS.delete(ICONS.keys().next().value);
  ICONS.set(mint, out);
  return out;
}

// ---------------- lucky bubbles ----------------
// A popped bubble sometimes wins a free coin from the drum, bought on Jupiter
// with SOL from the giveaway wallet and sent straight to the winner's wallet.
// The amounts and the coins are in laundry-core.js for anyone to read.
//
// A win hands the page a signed ticket, and taking the prize needs a signed-in
// wallet. Each wallet takes one prize a day and each connection two, and the
// day's prizes stop at a budget, so the jar cannot be emptied in one sitting.
const GIFT_SECRET = process.env.GIVEAWAY_SECRET || '';
const GIFT = {
  chance: Number(process.env.GIVEAWAY_CHANCE || 1 / 30),
  dailyUsd: Number(process.env.GIVEAWAY_DAILY_USD || 25),
  perIp: Number(process.env.GIVEAWAY_PER_IP || 2),
  cooldownMs: 1000,          // between draws from one connection
  ttlMs: 15 * 60e3,          // how long a won prize waits to be taken
  reserve: 5_000_000,        // lamports the wallet always keeps for fees
};
const lastPop = new Map();   // per-instance throttle on draws

const today = () => new Date().toISOString().slice(0, 10);
const clientIp = (req) => String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim() || 'unknown';
// connections are counted by a keyed hash that changes daily, never by the address itself
const ipKey = (req) => mac('ip:' + today() + ':' + clientIp(req)).slice(0, 16);
const signTicket = (t) => { const p = Buffer.from(JSON.stringify(t)).toString('base64url'); return p + '.' + mac('gift:' + p); };
function readTicket(s) {
  const [p, tag] = String(s || '').split('.');
  if (!p || !tag || !AUTH_SECRET || !safeEq(tag, mac('gift:' + p))) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
}
// Today's giveaway record, made on first use and trimmed to a week.
function giftDay(store, make) {
  const g = store.giveaway = store.giveaway || { days: {}, log: [] };
  const d = today();
  if (!g.days[d] && make) {
    g.days[d] = { usd: 0, wins: 0, ips: {}, used: [] };
    for (const k of Object.keys(g.days).sort().slice(0, -7)) delete g.days[k];
  }
  return g.days[d] || null;
}
let WASHER = null;
async function washer() {
  if (!WASHER) { const web3 = await import('@solana/web3.js'); WASHER = web3.Keypair.fromSecretKey(b58decode(LAUNDRY_SECRET.trim())); }
  return WASHER;
}
// The laundry wallet's balance, read at most every 30 seconds.
// A failed read keeps the last good one for ten minutes, so one bad answer from
// the network does not drop the site into practice mode.
let LAST_BAL = { v: 0, at: 0 };
async function washBalance() {
  try {
    const v = await cached('washbal', 30e3, async () => Number((await mainnetCall('getBalance', [(await washer()).publicKey.toBase58()])).value || 0));
    LAST_BAL = { v, at: Date.now() };
    return v;
  } catch (e) {
    console.warn('laundry balance unread', String((e && e.message) || e).slice(0, 120));
    return Date.now() - LAST_BAL.at < 10 * 60e3 ? LAST_BAL.v : 0;
  }
}
async function isLive() {
  return LIVE_SWITCH && (await washBalance()) >= MIN + ATA_RENT + FLOAT;
}
// The biggest wash the laundry can finish right now, even on the luckiest cycle.
// The player's payment lands before anything is paid out, so the float only has
// to cover what a lucky cycle adds on top.
const TOP_MULT = 1 + RANGE.max;
async function maxNow() {
  const bal = await washBalance();
  return Math.max(MIN, Math.min(MAX, Math.floor((bal - ATA_RENT - FLOAT) / (TOP_MULT - 1) / 1e6) * 1e6));
}

// ---------------- live washes, paid from the player's wallet ----------------
const memoFor = (id) => 'laundry:' + id;
// A wash still waiting on its payment: one from another chain for 30 minutes,
// one on Solana while its payment is known or for 3 minutes.
const liveJob = (j) => j.v === 2 && j.state === 'awaiting' && (j.kind === 'evm' ? Date.now() - Date.parse(j.at) < 30 * 60e3 : Boolean(j.paySig) || Date.now() - Date.parse(j.at) < 3 * 60e3);
// A wallet keeps its newest 50 washes, but a wash that is not over is never dropped.
const OPEN = ['awaiting', 'washing', 'unconfirmed', 'refunding', 'stuck'];
function trimJobs(w) {
  const list = w.laundry || [];
  if (list.length <= 50) return;
  const open = list.filter((j) => OPEN.includes(j.state));
  const over = list.filter((j) => !OPEN.includes(j.state)).slice(0, Math.max(0, 50 - open.length));
  w.laundry = [...open, ...over].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
// A busy public RPC turns callers away for a moment. Those calls are tried again;
// anything else fails at once. Sends are retried with the same signed
// transaction, so a retry can never pay twice.
// Only an error's first line is read: web3.js adds the program's log lines
// after it, and a log line like "consumed 42913 compute units" is not a 429.
const transient = (e) => /\b(429|500|502|503|504)\b|rate limit|too many requests|fetch failed|ECONNRESET|ETIMEDOUT|timed? ?out|socket hang up|aborted/i
  .test(String((e && (e.message || e)) || '').split('\n')[0]);
// A send the node answered with a refusal of its own (a failed simulation, a
// JSON-RPC error) never went out. Anything else (no answer, a dropped
// connection, an HTTP error) might have.
const refused = (e, web3) => Boolean(e) && ((web3 && ((web3.SendTransactionError && e instanceof web3.SendTransactionError)
  || (web3.SolanaJSONRPCError && e instanceof web3.SolanaJSONRPCError))) || Array.isArray(e.logs));
async function retry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (!transient(e) || i >= tries - 1) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
}
// A wash's record lives on the player's wallet in the ledger. Every change is
// made on a fresh copy, found by the wash's id, so other writes are kept.
// `fn` returning false means there is nothing to change: no write, and false
// comes back, which callers read as "not done". Any other failure is tried
// again, six times in all, with a short random wait between.
async function patchLedger(what, fn) {
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      const { store, tag } = await loadAt();
      const got = fn(store);
      if (got === false || got == null) return got === false ? false : null;
      await saveAt(store, tag);
      return got;
    } catch (e) { last = e; await sleep(60 + Math.random() * 200 * (i + 1)); }
  }
  console.error('ledger write gave up:', what, String((last && last.message) || last).slice(0, 160));
  return null;
}
const patchJob = (owner, id, fn) => patchLedger('wash ' + id, (store) => {
  const w = store.wallets[owner], job = w && (w.laundry || []).find((j) => j.id === id);
  if (!job) return null;
  return fn(job, w, store) === false ? false : job;
});
// The payment, found by its memo among the laundry's latest transactions, for
// when the page lost the signature (a reload mid-wash).
// The signature of this wash's payment, found by its memo; null when it is not
// there. Throws when the chain could not be read, so no wash lapses on a guess.
async function findPayment(laundry, memo, since) {
  let before;
  for (let page = 0; page < 5; page++) {
    const list = await mainnetCall('getSignaturesForAddress', [laundry, { limit: 1000, commitment: 'confirmed', ...(before ? { before } : {}) }]);
    // exact match: the laundry's own payout and refund carry this memo plus a suffix
    const hit = (list || []).find((s) => !s.err && s.memo && s.memo.split('; ').some((m) => m.trim().endsWith('] ' + memo)));
    if (hit) return hit.signature;
    const last = list && list[list.length - 1];
    if (!last || list.length < 1000 || (since && last.blockTime && last.blockTime * 1000 < since - 120e3)) return null;
    before = last.signature;
  }
  return undefined;                     // it stopped before reaching the wash's start: it cannot say
}
// Reads the payment back from the chain. It has to have succeeded, be signed by
// the player, carry this wash's memo, and leave the laundry up by what it paid.
async function readPayment({ signature, owner, laundry, memo }) {
  const tx = await mainnetCall('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]).catch(() => null);
  if (!tx || !tx.meta) return { pending: true };
  if (tx.meta.err) return { error: 'Your payment did not go through, so nothing was taken.' };
  const m = tx.transaction.message, la = tx.meta.loadedAddresses || {};
  const keys = [...m.accountKeys, ...(la.writable || []), ...(la.readonly || [])];
  // signed by the player (a wallet may have someone else pay the network fee)
  if (!m.accountKeys.slice(0, (m.header && m.header.numRequiredSignatures) || 1).includes(owner)) return { error: 'That payment came from another wallet.' };
  // exactly one laundry memo, and it is this wash's: one payment can never cover two washes
  const memos = (tx.meta.logMessages || []).filter((l) => /Memo \(len \d+\): "laundry:/.test(l));
  if (memos.length !== 1 || !memos[0].includes('"' + memo + '"')) return { error: 'That payment belongs to another wash.' };
  const i = keys.indexOf(laundry);
  if (i < 0) return { error: 'That payment did not reach the laundry.' };
  return { lamports: tx.meta.postBalances[i] - tx.meta.preBalances[i] };
}

// ---------------- paying from another chain ----------------
// ETH on Ethereum, Base or Robinhood Chain, or BNB on BNB Chain, pays for a wash
// through Relay (relay.link). The server asks Relay for the price with the
// laundry's Solana wallet as the receiver and ties Relay's request id to one
// wash, so a payment can only ever count for the wash it was quoted for. The
// wash runs once Relay reports the fill and the SOL is seen landing in the
// laundry, and a wash that cannot run is refunded in SOL to the player's
// Solana wallet, like any other.
const EVM = {
  eth: { id: 1, name: 'Ethereum', sym: 'ETH', explorer: 'https://etherscan.io' },
  base: { id: 8453, name: 'Base', sym: 'ETH', explorer: 'https://basescan.org' },
  robinhood: { id: 4663, name: 'Robinhood Chain', sym: 'ETH', explorer: 'https://robin.etherscan.io' },
  bnb: { id: 56, name: 'BNB Chain', sym: 'BNB', explorer: 'https://bscscan.com' },
};
const RELAY = 'https://api.relay.link', RELAY_SOLANA = 792703809, NATIVE_SOL = '11111111111111111111111111111111';
// Relay's contracts, the same on every chain: the receiver for ETH and BNB, and
// the router a token is approved to and paid through. Any other address is refused.
const RELAY_TO = ['0x4cd00e387622c35bddb9b4c962c136462338bc31'];
const RELAY_TOKEN_TO = ['0xccc88a9d1b4ed6b0eaba998850414b24f1c315be'];
const NATIVE_EVM = '0x0000000000000000000000000000000000000000';
const EVM_PLACEHOLDER = '0x000000000000000000000000000000000000dEaD';     // prices before a wallet is known
const evmCoin = (key) => ({ mint: 'evm:' + key, evm: key, symbol: EVM[key].sym, name: EVM[key].sym + ' on ' + EVM[key].name, decimals: 18 });
// "evm:base" is the chain's own coin; "evm:base:0x..." a token on that chain.
function evmSide(src) {
  const m = /^evm:(eth|base|robinhood|bnb)(?::(0x[0-9a-fA-F]{40}))?$/.exec(String(src.in || ''));
  if (!m) return null;
  const amount = String(src.amount ?? ''), token = m[2] && m[2].toLowerCase() !== NATIVE_EVM ? m[2].toLowerCase() : null;
  return { key: m[1], chain: EVM[m[1]], token, in: 'evm:' + m[1] + (token ? ':' + token : ''),
    wei: /^\d{1,40}$/.test(amount) && BigInt(amount) > 0n ? BigInt(amount).toString() : null };
}
async function relayQuote({ chain, wei, user, recipient, token, exactOut }) {
  const r = await fetch(RELAY + '/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(12000),
    body: JSON.stringify({ user, originChainId: chain.id, destinationChainId: RELAY_SOLANA, originCurrency: token || NATIVE_EVM,
      destinationCurrency: NATIVE_SOL, recipient, tradeType: exactOut ? 'EXACT_OUTPUT' : 'EXACT_INPUT', amount: wei, slippageTolerance: '100' }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(d.steps)) { const e = new Error(d.message || 'no route'); e.code = d.errorCode || 'NO_ROUTE'; throw e; }
  return d;
}
async function relayStatus(requestId) {
  const r = await fetch(RELAY + '/intents/status/v3?requestId=' + encodeURIComponent(requestId), { signal: AbortSignal.timeout(8000) });
  return r.json();
}
// The transactions Relay hands back, checked before anyone signs them. For a
// chain's own coin: one payment to Relay's receiver of exactly the amount. For
// a token: at most an approval of exactly the amount, then the payment,
// carrying no coin of its own, either through Relay's router or (USDC and USDT
// mostly) straight into Relay's receiver as depositErc20(depositor, token,
// amount, id), whose arguments are checked word by word. The approval is only
// ever to the contract the payment goes through. Both are for this chain and
// this sender. Returns the steps to sign, or null.
function relaySteps(rq, ev, from) {
  const steps = Array.isArray(rq.steps) ? rq.steps : [];
  const dep = steps[steps.length - 1], appr = steps.length === 2 ? steps[0] : null;
  if (!dep || steps.length > 2 || dep.kind !== 'transaction' || !dep.requestId || !Array.isArray(dep.items) || dep.items.length !== 1) return null;
  const tx = dep.items[0].data || {};
  const mine = (t) => Number(t.chainId) === ev.chain.id && String(t.from || '').toLowerCase() === from.toLowerCase();
  if (!mine(tx)) return null;
  if (!ev.token) {
    if (appr || !RELAY_TO.includes(String(tx.to).toLowerCase()) || BigInt(tx.value || 0) !== BigInt(ev.wei)) return null;
    return { requestId: dep.requestId, deposit: tx, approve: null };
  }
  const to = String(tx.to).toLowerCase(), data = String(tx.data || '').toLowerCase();
  const viaReceiver = RELAY_TO.includes(to) && /^0xe8017952[0-9a-f]{256}$/.test(data)
    && '0x' + data.slice(34, 74) === from.toLowerCase() && '0x' + data.slice(98, 138) === ev.token
    && BigInt('0x' + data.slice(138, 202)) === BigInt(ev.wei);
  if (!(RELAY_TOKEN_TO.includes(to) || viaReceiver) || BigInt(tx.value || 0) !== 0n) return null;
  let atx = null;
  if (appr) {
    if (appr.kind !== 'transaction' || appr.requestId !== dep.requestId || !Array.isArray(appr.items) || appr.items.length !== 1) return null;
    atx = appr.items[0].data || {};
    const d = String(atx.data || '').toLowerCase();
    if (!mine(atx) || String(atx.to).toLowerCase() !== ev.token || BigInt(atx.value || 0) !== 0n || d.length !== 138 || !d.startsWith('0x095ea7b3')
      || '0x' + d.slice(34, 74) !== String(tx.to).toLowerCase() || BigInt('0x' + d.slice(74, 138)) !== BigInt(ev.wei)) return null;
  }
  return { requestId: dep.requestId, deposit: tx, approve: atx };
}

// What a Relay fill left in the laundry wallet, read from the Solana transaction itself.
async function readFill(signature, laundry) {
  const tx = await mainnetCall('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]).catch(() => null);
  if (!tx || !tx.meta) return { pending: true };
  if (tx.meta.err) return { pending: true };                       // Relay tries again or refunds; either way, not yet
  const m = tx.transaction.message, la = tx.meta.loadedAddresses || {};
  const keys = [...m.accountKeys, ...(la.writable || []), ...(la.readonly || [])];
  const i = keys.indexOf(laundry);
  if (i < 0) return { error: 'That payment did not reach the laundry.' };
  return { lamports: tx.meta.postBalances[i] - tx.meta.preBalances[i] };
}
// Step 1 of a wash paid from another chain: has Relay filled it into the laundry?
// Returns { sig, paid } to go on with, or { reply: [status, body] } to answer now.
async function evmPaid(owner, job, body, laundry) {
  const hash = /^0x[0-9a-fA-F]{64}$/.test(String(body.evmTx || '')) ? String(body.evmTx) : null;
  if (hash && !job.evmTx) { await patchJob(owner, job.id, (j) => { j.evmTx = j.evmTx || hash; }); job.evmTx = hash; }
  const st = await relayStatus(job.requestId).catch(() => null);
  if (!st || typeof st.status !== 'string') return { reply: [202, { waiting: true }] };   // Relay did not answer: ask again later
  const status = st.status, coin = EVM[job.chain];
  if (status === 'refund' || status === 'failure') {
    const why = 'It could not cross, so Relay sends your ' + coin.sym + ' back on ' + coin.name + '. Nothing was taken.';
    await patchJob(owner, job.id, (j) => { if (j.state === 'awaiting') { j.state = 'failed'; j.error = why; } });
    return { reply: [400, { error: why }] };
  }
  if (status !== 'success') {
    const idle = !hash && !job.evmTx && (status === 'waiting' || status === 'unknown');
    if (idle && Date.now() - Date.parse(job.at) > 30 * 60e3) {
      const why = 'The payment never left your wallet, so nothing was taken.';
      await patchJob(owner, job.id, (j) => { if (j.state === 'awaiting') { j.state = 'expired'; j.error = why; } });
      return { reply: [400, { error: why }] };
    }
    return { reply: [202, { waiting: true }] };
  }
  const fill = (st.txHashes || []).find((x) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(String(x)));
  if (!fill) return { reply: [202, { waiting: true }] };
  let paid = { pending: true };
  for (let i = 0; i < 6 && paid.pending; i++) {
    paid = await readFill(fill, laundry);
    if (paid.pending) await new Promise((r) => setTimeout(r, 2000));
  }
  if (paid.pending) return { reply: [202, { waiting: true }] };
  if (paid.error) {
    await patchJob(owner, job.id, (j) => { if (j.state !== 'awaiting') return false; j.state = 'failed'; j.error = paid.error; });
    return { reply: [400, { error: paid.error }] };
  }
  return { sig: fill, paid };
}

// ---------------- sending money, once ----------------
// Everything the laundry sends goes out one way: signed first, its signature
// saved by `record` (which has to succeed), and only then sent, the same bytes
// again on a busy network. A send that errors may still have gone out, so it is
// never followed by a second payment: it is settled from the chain instead.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function b58encode(bytes) {
  const d = [0];
  for (const x of bytes) { let c = x; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
  let o = ''; for (const x of bytes) { if (x === 0) o += '1'; else break; }
  return o + d.reverse().map((x) => B58[x]).join('');
}
// What the chain says about a signature the laundry sent: 'ok', 'failed' (it
// failed, or its blockhash ran out before it landed), or null while it could
// still land. Throws when the chain could not be read. A missing status only
// counts as 'failed' when the node that gave it had reached a finalized point
// already past the transaction's last valid block, read from one node first,
// so a node that is behind can never make a sent transaction look lost.
async function settleSig(sig, validUntil) {
  const fin = validUntil ? await mainnetCall('getEpochInfo', [{ commitment: 'finalized' }]) : null;
  const r = await mainnetCall('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
  const st = ((r && r.value) || [])[0];
  if (st) return st.confirmationStatus === 'processed' ? null : (st.err ? 'failed' : 'ok');
  if (!fin || !(fin.blockHeight > validUntil)) return null;
  return r && r.context && r.context.slot >= fin.absoluteSlot ? 'failed' : null;
}
// A quick look at a fresh signature: 'ok', 'failed', or null while unsettled.
async function sigStatus(sig) {
  const r = await mainnetCall('getSignatureStatuses', [[sig]]);
  const st = ((r && r.value) || [])[0];
  if (!st || st.confirmationStatus === 'processed') return null;
  return st.err ? 'failed' : 'ok';
}
// Resolves { sig, status }: 'ok', 'failed' (did not and cannot land), or
// 'unknown' (settle it later with settleSig). Only `record` can throw, and it
// runs before anything is sent.
async function sendOnce({ conn, built, signer, record }) {
  const web3 = await import('@solana/web3.js');
  built.tx.sign([signer]);
  const sig = b58encode(built.tx.signatures[0]);
  await record(sig, built.lastValidBlockHeight);
  const raw = built.tx.serialize();
  let out = false, maybe = false;
  for (let i = 0; i < 3 && !out; i++) {
    try { await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }); out = true; }
    catch (e) {
      if (refused(e, web3)) break;                  // the node said no: that try never went out
      maybe = true; await sleep(1500 * (i + 1));    // no clear answer: it may have gone out
    }
  }
  if (!out && !maybe) return { sig, status: 'failed' };
  // Confirmed by asking over plain HTTP for about 20 seconds, never by waiting
  // on a websocket, which can hang past the function's time limit.
  for (let i = 0; i < 10; i++) {
    await sleep(i ? 2000 : 1200);
    const st = await sigStatus(sig).catch(() => null);
    if (st) return { sig, status: st };
  }
  const st = await settleSig(sig, built.lastValidBlockHeight).catch(() => null);
  return { sig, status: st || 'unknown' };
}
// A wash's refund, sent once. A request claims the refund on the ledger before
// building it, and a claim holds for 90 seconds, so two requests (two tabs, a
// reload, the sweeper) can never both send one. `replacing` is a refund the
// chain says failed, which a new one may take the place of. Returns [status, body].
async function refundOnce({ owner, id, lamports, why, replacing }) {
  const claim = crypto.randomUUID();
  const took = await patchJob(owner, id, (x) => {
    if (['refunded', 'done', 'expired', 'failed'].includes(x.state)) return false;
    if (x.refundSig && x.refundSig !== replacing) return false;               // one is out there: the chain settles it
    if (x.refundClaim && Date.now() - x.refundClaim.at < 90e3) return false;  // another request is on it
    x.refundClaim = { id: claim, at: Date.now() }; x.state = 'refunding'; x.error = why; x.refundLamports = lamports;
    delete x.refundSig; delete x.refundValid;
  });
  if (!took) return [202, { waiting: true, error: why + ' Your refund is on its way.' }];
  const web3 = await import('@solana/web3.js');
  const { buildSend } = await import('../laundry-swap.js');
  const conn = mainnetConn(web3), house = await washer();
  let sent, failure = '';
  try {
    const built = await retry(() => buildSend({ conn, web3, from: house.publicKey, to: owner, lamports, memo: memoFor(id) + ':refund' }));
    sent = await sendOnce({ conn, built, signer: house, record: async (sig, valid) => {
      const ok = await patchJob(owner, id, (x) => { if (!x.refundClaim || x.refundClaim.id !== claim) return false; x.refundSig = sig; x.refundValid = valid; });
      if (!ok) throw new Error('the refund could not be recorded');
    } });
  } catch (e) { failure = String((e && e.message) || e).slice(0, 200); sent = { status: 'failed' }; }
  if (sent.status === 'ok') {
    const explorer = `https://solscan.io/tx/${sent.sig}`;
    await patchJob(owner, id, (x, ww) => {
      x.state = 'refunded'; x.refund = sent.sig; x.explorer = explorer; delete x.refundClaim;
      if (x.freeRinse && ww.rinseDay === String(x.claimedAt || '').slice(0, 10)) ww.rinseToday = Math.max(0, (ww.rinseToday || 1) - 1);   // no fee used up by a wash that never ran
    });
    return [502, { error: why + ' Your SOL has been sent back.', explorer, refunded: true }];
  }
  if (sent.status === 'failed') {
    if (failure) console.error('refund not sent', id, failure);
    await patchJob(owner, id, (x) => {
      if (!x.refundClaim || x.refundClaim.id !== claim) return false;
      x.state = 'stuck'; x.error = why; x.refundLamports = lamports; x.refundError = failure;
      delete x.refundSig; delete x.refundValid; delete x.refundClaim;
    });
    return [202, { waiting: true, error: why + ' Your refund will go out shortly.' }];
  }
  // out there but not confirmed yet: the chain settles it on a later ask
  await patchJob(owner, id, (x) => { if (!x.refundClaim || x.refundClaim.id !== claim) return false; delete x.refundClaim; });
  return [202, { waiting: true, error: why + ' Your refund is on its way.', explorer: `https://solscan.io/tx/${sent.sig}` }];
}
// A wash left mid-way (a send not yet confirmed, a refund owed, or a server
// that stopped) is settled from the chain on the next ask, never paid twice.
async function settleWash(res, owner, job) {
  const reply = ([code, body]) => res.status(code).json(body);
  const age = Date.now() - Date.parse(job.claimedAt || job.at);
  const back = job.kind === 'evm' ? job.paid : job.expect;
  if (job.state === 'stuck') return reply(await refundOnce({ owner, id: job.id, lamports: job.refundLamports || back, why: job.error || 'The wash could not start.' }));
  if (job.state === 'refunding') {
    const why = job.error || 'The wash could not start.';
    // claimed but never signed (the request stopped): the claim runs out and another takes it
    if (!job.refundSig) return reply(await refundOnce({ owner, id: job.id, lamports: job.refundLamports || back, why }));
    const st = await settleSig(job.refundSig, job.refundValid || (age > 180e3 ? 1 : 0)).catch(() => null);
    if (st === 'ok') {
      const explorer = `https://solscan.io/tx/${job.refundSig}`;
      await patchJob(owner, job.id, (x) => { if (x.refundSig !== job.refundSig) return false; x.state = 'refunded'; x.refund = job.refundSig; x.explorer = explorer; delete x.refundClaim; });
      return reply([502, { error: why + ' Your SOL has been sent back.', explorer, refunded: true }]);
    }
    if (st === 'failed') return reply(await refundOnce({ owner, id: job.id, lamports: job.refundLamports || back, why, replacing: job.refundSig }));
    return reply([202, { waiting: true, explorer: `https://solscan.io/tx/${job.refundSig}` }]);
  }
  // washing or unconfirmed: what became of the payout
  if (job.outSig) {
    const st = await settleSig(job.outSig, job.outValid || (age > 180e3 ? 1 : 0)).catch(() => null);   // an old payout's blockhash is long gone
    if (st === 'ok') return res.status(200).json(await completeWash({ owner, job, signature: job.outSig }));
    if (st === 'failed') return reply(await refundOnce({ owner, id: job.id, lamports: back, why: 'The wash could not finish.' }));
    return reply([202, { waiting: true, explorer: `https://solscan.io/tx/${job.outSig}` }]);
  }
  // claimed under send-once and stopped before a payout was even signed: nothing went out
  if (job.state === 'washing' && job.once && age > 120e3) return reply(await refundOnce({ owner, id: job.id, lamports: back, why: 'The wash could not start.' }));
  return reply([202, { waiting: true }]);
}
// Marks a paid-out wash done and builds what the page shows. The amounts come
// from the wash's own record, so a wash settled later reads the same.
async function completeWash({ owner, job, signature }) {
  const range = job.range || { lo: 0.1, hi: 0.1 };
  const drawn = washCycle(job.seed, job.clientSeed, job.nonce, range);
  const cycle = job.freeRinse ? { key: 'rinse', name: 'No fee', chance: 0, mult: 1, drew: drawn.mult } : drawn;
  const base = job.base || (job.kind === 'evm' ? Math.min(job.paid, job.quoted || job.paid) : job.expect);
  const gross = Math.floor(base * cycle.mult), washed = job.washed != null ? job.washed : gross;
  const tok = job.mint === SOL_MINT ? { mint: SOL_MINT, symbol: 'SOL', name: 'Solana', decimals: 9 } : await tokenByMint(job.mint);
  let got = String(washed);
  if (job.mint !== SOL_MINT) {
    const web3 = await import('@solana/web3.js');
    const { received } = await import('../laundry-swap.js');
    const conn = mainnetConn(web3);
    got = await received({ conn, signature, owner, mint: job.mint }).catch(() => null);
    if (!got || got === '0') got = job.quoteOut || '0';                 // the chain has not caught up yet
  }
  const result = { live: true, cycle, lamports: base, washed, out: Number(got) / 10 ** tok.decimals, token: tok, signature,
    paySignature: job.paySig, ...(job.kind === 'evm' ? { payExplorer: job.evmTx ? EVM[job.chain].explorer + '/tx/' + job.evmTx : null, payChain: EVM[job.chain].name } : {}),
    explorer: `https://solscan.io/tx/${signature}`, fairness: { hash: job.hash, seed: job.seed, nonce: job.nonce, clientSeed: job.clientSeed, range, ...(job.freeRinse ? { freeRinse: true } : {}) } };
  const marked = await patchJob(owner, job.id, (x, ww, s) => {
    if (x.state === 'done') return false;
    x.state = 'done'; x.out = got; x.outSig = signature; x.result = result;
    // the laundry's winnings: kept on a shrunk wash, given back on a lucky one
    s.laundryPool = Math.round((s.laundryPool || 0) + (base - gross));
    (ww.history = ww.history || []).unshift({ game: 'laundry', bet: base, win: 0, mult: cycle.mult, mint: job.mint, out: got,
      signature, nonce: job.nonce, hash: job.hash, at: job.at });
    if (ww.history.length > 50) ww.history.length = 50;
    socksSwap(ww, s);
  });
  if (marked === null) console.error('wash paid out but not marked done; the sweeper will', job.id);
  return result;
}

// Sets up a wash paid from another chain: Relay's price with the laundry as the
// receiver, checked, and tied to this wash by Relay's request id.
async function payEvm(req, res, body, owner, ev) {
  const mint = String(body.mint || ''), from = String(body.from || '');
  const clientSeed = String(body.clientSeed || '').slice(0, 64) || 'g00b';
  if (!isMint(mint)) return res.status(400).json({ error: 'Pick a token' });
  if (!ev.wei) return res.status(400).json({ error: 'Enter an amount' });
  if (!/^0x[0-9a-fA-F]{40}$/.test(from)) return res.status(400).json({ error: 'Pick the wallet you pay from.' });
  const range = validRange(body.range) ? { lo: body.range.lo, hi: body.range.hi } : null;
  if (!range) return res.status(400).json({ error: 'Reload the page to get a swap fee range.' });
  const laundry = (await washer()).publicKey.toBase58();
  let rq;
  try { rq = await relayQuote({ chain: ev.chain, wei: ev.wei, user: from, recipient: laundry, token: ev.token }); }
  catch (e) {
    return res.status(400).json({ error: e.code === 'AMOUNT_TOO_LOW' ? 'That is too little to bring across. Try a bit more.' : 'No way across from ' + ev.chain.name + ' right now. Try again soon.' });
  }
  const steps = relaySteps(rq, ev, from), out = rq.details && rq.details.currencyOut;
  const ok = steps && rq.details.recipient === laundry && out && out.currency && out.currency.address === NATIVE_SOL && /^\d+$/.test(String(out.amount));
  if (!ok) return res.status(502).json({ error: 'The bridge sent back something unexpected, so nothing was set up. Try again later.' });
  const tx = steps.deposit, cin = (rq.details.currencyIn && rq.details.currencyIn.currency) || {};
  const quoted = Number(out.amount), least = Number(out.minimumAmount || out.amount), top = await maxNow();
  if (!(least >= MIN) || quoted > top) return res.status(400).json({ error: `Washes run from ${MIN / LAMPORTS} to ${top / LAMPORTS} SOL worth` });
  const id = crypto.randomUUID();
  let reply = null, round = null;
  const saved = await patchLedger('pay evm', (store) => {
    const w = store.wallets[owner];
    if (!w?.round?.seed || w.round.game !== 'laundry') { reply = [409, { error: 'The machine reset, press Swap again', recommit: true }]; return false; }
    if ((w.laundry || []).filter(liveJob).length >= 3) { reply = [429, { error: 'Finish your last wash first, or give it a few minutes.' }]; return false; }
    round = w.round;
    w.round = { nonce: round.nonce };
    (w.laundry = w.laundry || []).unshift({ id, v: 2, kind: 'evm', chain: ev.key, from, in: ev.in, amount: ev.wei, mint, expect: least, quoted,
      ...(ev.token ? { token: ev.token, inSymbol: String(cin.symbol || '?').slice(0, 16), inDecimals: (Number.isInteger(Number(cin.decimals)) ? Number(cin.decimals) : 18) } : {}),
      requestId: steps.requestId, seed: round.seed, hash: round.hash, nonce: round.nonce, clientSeed, range, at: new Date().toISOString(), state: 'awaiting' });
    trimJobs(w);
    return w;
  });
  if (reply) return res.status(reply[0]).json(reply[1]);
  if (!saved) return res.status(503).json({ error: 'The laundry is busy. Press Swap again.' });
  const { hash, nonce } = round;
  const plain = (t) => ({ to: t.to, data: t.data, value: String(t.value || '0'), chainId: ev.chain.id, gas: t.gas ? String(t.gas) : null });
  return res.status(200).json({ job: id, evm: plain(tx), approve: steps.approve ? plain(steps.approve) : null, lamports: quoted, hash, nonce });
}

async function liveWash(req, res, body, asOwner) {
  const owner = asOwner || ownerFromSession(req);
  if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
  const id = String(body.job || '');
  const first = await loadAt();
  const job = ((first.store.wallets[owner] || {}).laundry || []).find((j) => j.id === id && j.v === 2);
  if (!job) return res.status(404).json({ error: 'That wash was not found.' });
  if (job.state === 'done') return res.status(200).json(job.result);
  if (['washing', 'unconfirmed', 'refunding', 'stuck'].includes(job.state)) return settleWash(res, owner, job);
  if (job.state !== 'awaiting') return res.status(400).json({ error: job.error || 'That wash is over.', explorer: job.explorer || null });

  const web3 = await import('@solana/web3.js');
  const spl = await import('@solana/spl-token');
  const { buildSwap, buildSend, sendSwap, received, destination } = await import('../laundry-swap.js');
  const conn = mainnetConn(web3);
  const house = await washer(), laundry = house.publicKey.toBase58(), memo = memoFor(job.id);

  // ---- 1. the payment ----
  let sig, paid;
  if (job.kind === 'evm') {
    const got = await evmPaid(owner, job, body, laundry);
    if (got.reply) return res.status(got.reply[0]).json(got.reply[1]);
    ({ sig, paid } = got);
  } else {
    sig = job.paySig || (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(String(body.signature || '')) ? String(body.signature) : null);
    if (!sig && typeof body.signed === 'string' && body.signed.length < 3000) {
      // The payment's signature is read off the signed bytes and written down
      // before it is sent, so an answer lost on the way back (or a second send
      // of the same bytes) can never lose a payment that went through.
      const raw = Buffer.from(body.signed, 'base64');
      if (raw.length > 65 && raw[0] >= 1 && raw[0] < 0x80) {
        sig = b58encode(raw.subarray(1, 65));
        await patchJob(owner, id, (j) => { if (j.state !== 'awaiting' || j.paySig) return false; j.paySig = sig; });
        await mainnetCall('sendTransaction', [body.signed, { encoding: 'base64', maxRetries: 3 }])
          .catch((e) => console.warn('payment send', id, String((e && e.message) || e).slice(0, 160)));   // sent already, or refused: the chain says which
      }
    }
    const searched = sig ? null : await findPayment(laundry, memo, Date.parse(job.at)).catch(() => undefined);
    if (!sig && searched) sig = searched;
    paid = { pending: true };
    // a fresh payment gets about 20 seconds to confirm; an old one is looked up once
    const tries = Date.now() - Date.parse(job.at) > 120e3 ? 1 : 10;
    for (let i = 0; sig && i < tries && paid.pending; i++) {
      if (i) await sleep(2000);
      paid = await readPayment({ signature: sig, owner, laundry, memo });
    }
    if (paid.pending) {
      // A payment that can never land is let go: its blockhash ran out and the
      // chain never saw it, or (with no signature) a look found nothing.
      const age = Date.now() - Date.parse(job.at);
      const gone = sig ? (await settleSig(sig, job.payValid || (age > 180e3 ? 1 : 0)).catch(() => null)) === 'failed'
        : searched === null && age > 3 * 60e3;
      if (gone) {
        await patchJob(owner, id, (j) => { if (j.state !== 'awaiting') return false; j.state = 'expired'; j.error = 'The payment never arrived, so nothing was taken.'; });
        return res.status(400).json({ error: 'The payment never arrived, so nothing was taken.' });
      }
      if (sig) await patchJob(owner, id, (j) => { if (j.paySig) return false; j.paySig = sig; });
      return res.status(202).json({ waiting: true });
    }
    if (paid.error) {
      await patchJob(owner, id, (j) => { if (j.state === 'awaiting') { j.state = 'failed'; j.error = paid.error; j.paySig = sig; } });
      return res.status(400).json({ error: paid.error });
    }
  }

  // ---- 2. claim it: one request, and only one, pays this wash out ----
  const { store, tag } = await loadAt();
  const w = store.wallets[owner], j = (w.laundry || []).find((x) => x.id === id);
  if (!j || j.state !== 'awaiting') return res.status(202).json({ waiting: true });
  if (sig && (w.laundry || []).some((x) => x.id !== id && x.paySig === sig)) {
    j.state = 'failed'; j.error = 'That payment was already used for another wash.';
    try { await saveAt(store, tag); } catch {}
    return res.status(400).json({ error: j.error });
  }
  j.state = 'washing'; j.paySig = sig; j.paid = paid.lamports; j.claimedAt = new Date().toISOString(); j.once = 1;
  const rinse = freeRinseFor(w, job.expect);
  if (rinse) j.freeRinse = true;
  try { await saveAt(store, tag); }
  catch { return res.status(202).json({ waiting: true }); }      // another request has it

  const refund = async (lamports, why) => { const [code, out] = await refundOnce({ owner, id, lamports, why }); return res.status(code).json(out); };
  // a payment from another chain washes what arrived, up to what Relay quoted
  const base = job.kind === 'evm' ? Math.min(paid.lamports, job.quoted || paid.lamports) : job.expect;
  const back = job.kind === 'evm' ? paid.lamports : job.expect;   // what a refund returns
  if (paid.lamports < job.expect) {
    if (paid.lamports > 10_000) return refund(paid.lamports, 'The payment came in short.');
    await patchJob(owner, id, (x) => { x.state = 'failed'; x.error = 'No payment reached the laundry.'; });
    return res.status(400).json({ error: 'No payment reached the laundry, so nothing was taken.' });
  }

  // ---- 3. the wash: the committed seed decides the cycle ----
  const range = job.range || { lo: 0.1, hi: 0.1 };
  const drawn = washCycle(job.seed, job.clientSeed, job.nonce, range);
  // no fees (inside, "Free Rinse"): the wash is a plain swap, nothing taken and nothing
  // added, so the reward costs the laundry nothing and the draw is still shown
  const cycle = rinse ? { key: 'rinse', name: 'No fee', chance: 0, mult: 1, drew: drawn.mult } : drawn;
  const gross = Math.floor(base * cycle.mult);
  let built, washed;
  try {
    if (job.mint === SOL_MINT) {
      washed = gross;
      built = await retry(() => buildSend({ conn, web3, from: house.publicKey, to: owner, lamports: washed, memo: memo + ':out' }));
    } else {
      // a first-time holder's token account is opened out of the wash
      const dest = await retry(() => destination({ conn, web3, spl, owner, mint: job.mint }));
      washed = gross - (dest.exists ? 0 : ATA_RENT);
      built = await retry(() => buildSwap({ conn, web3, spl, house: house.publicKey, owner, mint: job.mint, lamports: washed }));
    }
    const float = await retry(() => conn.getBalance(house.publicKey));
    if (float - washed - ATA_RENT < FLOAT) throw new Error('low float');
  } catch (e) { return refund(back, 'The wash could not start.'); }

  let sent;
  try {
    sent = await sendOnce({ conn, built, signer: house, record: async (outSig, outValid) => {
      const ok = await patchJob(owner, id, (x) => { x.outSig = outSig; x.outValid = outValid; x.washed = washed; x.base = base;
        x.quoteOut = built.quote ? String(built.quote.outAmount) : String(washed); });
      if (!ok) throw new Error('the payout could not be recorded');
    } });
  } catch (e) { return refund(back, 'The wash could not start.'); }     // nothing went out: the record comes first
  if (sent.status === 'failed') {
    await patchJob(owner, id, (x) => { delete x.outSig; delete x.outValid; });
    return refund(back, 'The wash could not start.');
  }
  if (sent.status === 'unknown') {
    await patchJob(owner, id, (x) => { x.state = 'unconfirmed'; x.explorer = `https://solscan.io/tx/${sent.sig}`; });
    return res.status(202).json({ waiting: true, error: 'The wash is taking a while. Check your wallet in a minute.', signature: sent.sig, explorer: `https://solscan.io/tx/${sent.sig}` });
  }
  const fresh = (await loadAt()).store.wallets[owner].laundry.find((x) => x.id === id);
  return res.status(200).json(await completeWash({ owner, job: fresh, signature: sent.sig }));
}
// ---------------- lucky socks: invite links ----------------
// Every wallet has a link. A friend who signs in through it gets 300 bubbles
// and so does the wallet that sent it. When that friend makes a first real
// swap, the sender gets 500 more, and every third friend who swaps gives the
// sender 7 days of no fees: washes up to 0.1 SOL, 5 a day, go through as plain swaps.
const SOCKS = { join: 300, swap: 500, perRinse: 3, rinseDays: 7, rinseMax: 100_000_000, rinsePerDay: 5, perDay: 10 };
const refCode = (owner) => mac('ref:' + owner).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
// The round's free bubbles, if this wallet has not had them yet. Setting the
// count also sets aside every pop counted before it (`box` is the wallet's pop
// file, below), since a new round starts everyone at 200.
function starterFor(w, box) {
  if ((w.starterRound || (w.starterAt ? 1 : 0)) >= STARTER_ROUND) return 0;
  w.pops = STARTER_POPS; w.starterAt = new Date().toISOString(); w.starterRound = STARTER_ROUND;
  if (box) w.popsTaken = box.total || 0;
  return STARTER_POPS;
}
// ---------------- bubble counts ----------------
// Pops arrive every few seconds from every open page, so they are counted in a
// small file of each wallet's own (laundry/pops/<wallet>.json), never in the
// shared ledger, where they would get in the way of swaps. The ledger takes
// them in when they are spent or shown: the file's `total` only ever grows,
// and the ledger remembers how much of it it has taken (`popsTaken`), so
// taking them in twice adds nothing.
const popKey = (owner) => 'laundry/pops/' + owner + '.json';
async function readPops(owner) {
  const r = await get(popKey(owner), { access: 'private', useCache: false, abortSignal: AbortSignal.timeout(6000) });
  if (!r) return { box: { total: 0 }, tag: null };
  const box = JSON.parse(await new Response(r.stream).text());
  const tag = String((r.blob && r.blob.etag) || '').replace(/^W\//, '') || (await head(popKey(owner))).etag;
  return { box, tag };
}
async function writePops(owner, box, tag) {
  const o = { access: 'private', contentType: 'application/json', addRandomSuffix: false, cacheControlMaxAge: 0 };
  await put(popKey(owner), JSON.stringify(box), tag ? { ...o, allowOverwrite: true, ifMatch: tag } : { ...o, allowOverwrite: false });
}
function takePops(w, box) {
  const fresh = Math.max(0, (box.total || 0) - (w.popsTaken || 0));
  if (fresh) w.pops = Math.min(9999, (w.pops || 0) + fresh);
  w.popsTaken = Math.max(w.popsTaken || 0, box.total || 0);
  return fresh;
}
// A wallet's count as it stands: the ledger's plus what its file has not handed over yet.
const popsNow = (w, box) => Math.min(9999, (w ? w.pops || 0 : 0) + Math.max(0, (box.total || 0) - ((w && w.popsTaken) || 0)));
function freeRinseFor(w, lamports) {
  if (!((w.freeRinseUntil || 0) > Date.now()) || lamports > SOCKS.rinseMax) return false;
  const d = today();
  if (w.rinseDay !== d) { w.rinseDay = d; w.rinseToday = 0; }
  if (w.rinseToday >= SOCKS.rinsePerDay) return false;
  w.rinseToday++;
  return true;
}
// A referred wallet's first finished live swap pays the wallet that sent it.
function socksSwap(w, store) {
  if (!w.referredBy || w.refPaid) return;
  w.refPaid = true;
  const inv = store.wallets[w.referredBy];
  if (!inv) return;
  inv.pops = Math.min(9999, (inv.pops || 0) + SOCKS.swap);
  inv.refSwaps = (inv.refSwaps || 0) + 1;
  if (inv.refSwaps % SOCKS.perRinse === 0) inv.freeRinseUntil = Math.max(Date.now(), inv.freeRinseUntil || 0) + SOCKS.rinseDays * 864e5;
}
const socksInfo = (owner, w) => ({ code: refCode(owner), join: SOCKS.join, swap: SOCKS.swap, perRinse: SOCKS.perRinse, rinseDays: SOCKS.rinseDays,
  rinseMax: SOCKS.rinseMax, rinsePerDay: SOCKS.rinsePerDay, joined: w.refJoined || 0, swapped: w.refSwaps || 0,
  rinseUntil: (w.freeRinseUntil || 0) > Date.now() ? w.freeRinseUntil : null,
  rinseLeft: (w.freeRinseUntil || 0) > Date.now() ? SOCKS.rinsePerDay - (w.rinseDay === today() ? w.rinseToday || 0 : 0) : 0 });

// ---------------- the vending machine ----------------
// Pulls cost bubbles. An NFT win is claimed from the vending wallet, which holds
// the NFTs to give. A wallet or a connection wins at most one NFT a day, and
// everyone together five, so the machine cannot be emptied in a sitting.
const VEND_SECRET = process.env.VEND_SECRET || '';
const VEND_LIMITS = { perWalletDay: 1, perIpDay: 1, perDay: 5 };
const STARTER_POPS = 200;          // every wallet's count is set to this once a round
const STARTER_ROUND = 4;           // raise it and every count resets to 200 on the wallet's next visit
const VEND_GIFT_ROUND = 1;         // raise it and the next pull, by anyone, drops a g00b from the house
let VENDER = null;
async function vender() {
  if (!VENDER) { const web3 = await import('@solana/web3.js'); VENDER = web3.Keypair.fromSecretKey(b58decode(VEND_SECRET.trim())); }
  return VENDER;
}
// The NFTs the vending wallet can give right now: each one it holds whose
// metadata puts it in a verified collection on the list. Read at most every 30
// seconds; when the chain cannot be read, the last good answer stands.
const TM_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
let lastStock = [];
async function vendStock(fresh, strict) {
  if (!VEND_SECRET) return [];
  if (fresh) memo.delete('vendstock');
  try {
    return await cached('vendstock', 30e3, async () => {
      const web3 = await import('@solana/web3.js');
      const owner = (await vender()).publicKey.toBase58();
      const lists = await Promise.all(TOKEN_PROGRAMS.map((programId) =>
        retry(() => mainnetCall('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]))));
      const mints = [...new Set(lists.flatMap((l) => l.value || []).map((a) => a.account.data.parsed.info)
        .filter((i) => i.tokenAmount.decimals === 0 && i.tokenAmount.amount === '1').map((i) => i.mint))];
      const tm = new web3.PublicKey(TM_PROGRAM), keys = new Set(VEND_COLLECTIONS.map((c) => c.key));
      const { readMetadata } = await import('../laundry-swap.js');
      const good = [];
      for (let i = 0; i < mints.length; i += 100) {
        const part = mints.slice(i, i + 100);
        const pdas = part.map((m) => web3.PublicKey.findProgramAddressSync([Buffer.from('metadata'), tm.toBuffer(), new web3.PublicKey(m).toBuffer()], tm)[0].toBase58());
        const r = await retry(() => mainnetCall('getMultipleAccounts', [pdas, { encoding: 'base64' }]));
        (r.value || []).forEach((acc, k) => {
          if (!acc) return;
          try {
            const meta = readMetadata(Buffer.from(acc.data[0], 'base64'));
            if (meta.verified && meta.collection && keys.has(new web3.PublicKey(meta.collection).toBase58())) good.push(part[k]);
          } catch {}
        });
      }
      lastStock = good;
      return good;
    });
  } catch (e) { if (strict) throw e; return lastStock; }
}
// Whether a wallet holds a given NFT, straight from the chain (throws when it cannot tell).
async function holdsMint(owner, mint) {
  const r = await mainnetCall('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);
  return (r.value || []).some((a) => a.account.data.parsed.info.tokenAmount.amount === '1');
}
// A claim the server lost track of (the function stopped mid-send, or the send
// never confirmed) is settled from the chain once its transaction is too old to
// land: sent, or still in the machine and so open to claim again.
async function settleWin(owner, win) {
  if (Date.now() - (win.claimAt || 0) < 180e3) return null;
  try {
    if (win.signature) {
      const st = await settleSig(win.signature, win.validUntil || 1);   // an old claim's blockhash is long gone
      if (st === 'ok') return 'claimed';
      if (st === null) return null;
      return 'won';                                                     // it never landed: send another
    }
    if (!win.mint || await holdsMint((await vender()).publicKey.toBase58(), win.mint)) return 'won';
    return 'claimed';                                                   // it left the machine long ago
  } catch {}
  return null;
}
// What a claimed NFT is called and looks like, for the page. Best effort.
async function nftCard(mint) {
  try {
    const web3 = await import('@solana/web3.js');
    const { readMetadata } = await import('../laundry-swap.js');
    const tm = new web3.PublicKey(TM_PROGRAM);
    const pda = web3.PublicKey.findProgramAddressSync([Buffer.from('metadata'), tm.toBuffer(), new web3.PublicKey(mint).toBuffer()], tm)[0];
    const acc = await mainnetCall('getAccountInfo', [pda.toBase58(), { encoding: 'base64' }]);
    const meta = readMetadata(Buffer.from(acc.value.data[0], 'base64'));
    let image = null;
    if (/^https:\/\//.test(meta.uri)) {
      const j = await fetch(meta.uri, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
      if (j && typeof j.image === 'string' && /^https:\/\//.test(j.image)) image = j.image;
    }
    return { name: meta.name || null, image };
  } catch { return { name: null, image: null }; }
}
// The machine as the page sees it. Never fails: a machine it cannot read shows empty.
async function vendInfo() {
  const base = { ...VEND, collections: VEND_COLLECTIONS, limits: VEND_LIMITS, stock: 0, wallet: null };
  if (!VEND_SECRET) return base;
  try {
    const [stock, { store }, key] = await Promise.all([vendStock(), loadAt(), vender()]);
    return { ...base, stock: Math.max(0, stock.length - openWins(store)), wallet: key.publicKey.toBase58() };
  } catch { return base; }
}
// A new wallet's record. One connection starts at most 30 new wallets a day
// on free bubbles, so a script making throwaway wallets cannot flood the
// ledger or farm them. Swaps and pulls are never held back by it, and phones
// sharing one carrier address are well inside it.
const newWallet = () => ({ staked: {}, detail: {}, accrued: 0 });
const BORN_PER_IP = Number(process.env.LAUNDRY_NEW_WALLETS_PER_IP || 30);
function bornOk(store, req) {
  const d = today(), ip = ipKey(req);
  const b = store.born = store.born && store.born.day === d ? store.born : { day: d, ips: {} };
  if ((b.ips[ip] || 0) >= BORN_PER_IP) return false;
  b.ips[ip] = (b.ips[ip] || 0) + 1;
  return true;
}
// Candy bars a wallet has pulled. Pulls before the count began are counted from
// the ones still on record.
const candyOf = (w) => w.candy ?? (w.vendPulls || []).filter((x) => x.kind === 'candy').length;
// Wins not yet sent hold an NFT back, so the machine never promises one it lacks.
function openWins(store) {
  let n = 0;
  for (const w of Object.values(store.wallets || {})) for (const x of (w.vendWins || [])) if (x.state !== 'claimed') n++;
  return n;
}
const patchWallet = (owner, fn) => patchLedger('wallet', (store) => {
  const w = store.wallets[owner];
  if (!w) return null;
  return fn(w, store) === false ? false : w;
});

let GIVER = null;
async function giver() {
  if (!GIVER) { const web3 = await import('@solana/web3.js'); GIVER = web3.Keypair.fromSecretKey(b58decode(GIFT_SECRET.trim())); }
  return GIVER;
}
// Whether the jar can pay the smallest prize right now. The balance is read at
// most every 30 seconds.
async function giftOn() {
  if (!GIFT_SECRET || !(GIFT.dailyUsd > 0) || !(GIFT.chance > 0)) return false;
  try {
    return await cached('giftbal', 30e3, async () => {
      const web3 = await import('@solana/web3.js');
      const conn = mainnetConn(web3);
      const [bal, px] = await Promise.all([conn.getBalance((await giver()).publicKey), priceOf([SOL_MINT])]);
      if (!px(SOL_MINT)) return false;
      const smallest = Math.round(GIFT_BANDS[0].from / px(SOL_MINT) * LAMPORTS);
      return bal >= smallest + 2 * ATA_RENT + 300_000 + GIFT.reserve;
    });
  } catch { return false; }
}
const patchGiftById = (id, fn) => patchLedger('prize ' + id, (store) => {
  const g = (((store.giveaway || {}).log) || []).find((x) => x.id === id);
  if (!g) return null;
  return fn(g, store) === false ? false : g;
});
// Takes a failed claim back out of the ledger, so the same ticket can try again.
function undoClaim(store, { d, n, usd, ip, owner, prevDay, id, error }) {
  const day = store.giveaway && store.giveaway.days && store.giveaway.days[d];
  if (day && day.used.includes(n)) {
    day.used = day.used.filter((x) => x !== n);
    day.usd = Math.round((day.usd - usd) * 100) / 100; day.wins -= 1; day.ips[ip] = Math.max(0, (day.ips[ip] || 1) - 1);
  }
  const w = store.wallets[owner];
  if (w && w.giftDay === d) { if (prevDay) w.giftDay = prevDay; else delete w.giftDay; }
  const job = ((store.giveaway && store.giveaway.log) || []).find((j) => j.id === id);
  if (job) { job.state = 'failed'; job.error = error; }
}

// A stand-in for a reply, for the sweeper to run a page's ask with.
const captured = () => { const c = { code: 200, body: null, status(x) { c.code = x; return c; }, json(d) { c.body = d; return c; }, setHeader() {}, end() { return c; } }; return c; };
let BACKED_UP = '';

// ---------------- handler ----------------
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = String(req.query.q || '');
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const LIVE = (q === 'config' || q === 'quote' || q === 'wash' || q === 'pay') ? await isLive() : false;

  try {
    if (q === 'config') {
      const [sol, ...shelf] = await Promise.all([SOL_MINT, ...SHELF].map((m) => tokenByMint(m).catch(() => null)));
      return res.status(200).json({ live: LIVE, network: NETWORK, min: MIN, max: LIVE ? await maxNow() : MAX,
        wallet: LAUNDRY_SECRET ? (await washer()).publicKey.toBase58() : null,
        cycles: CYCLES, range: RANGE, rentLamports: ATA_RENT, sol, shelf: shelf.filter(Boolean),
        gift: { on: await giftOn() },
        vend: await vendInfo() });
    }

    // ---- the sweeper: every ten minutes, finishes whatever a page left behind ----
    // Washes, prizes and NFT claims that stopped part way (a closed tab, a
    // request that ran out of time) are settled from the chain here, by the
    // same code a page's own ask runs, so nothing waits on the player coming back.
    if (q === 'sweep') {
      if (!CRON_SECRET || !safeEq(String(req.headers.authorization || ''), 'Bearer ' + CRON_SECRET)) return res.status(401).json({ error: 'Not allowed' });
      const t0 = Date.now(), seen = [];
      const { store } = await loadAt();
      const due = [];
      for (const [owner, w] of Object.entries(store.wallets || {})) {
        for (const j of (w.laundry || [])) {
          if (j.v !== 2) continue;
          const age = Date.now() - Date.parse(j.claimedAt || j.at);
          const open = ['washing', 'unconfirmed', 'refunding', 'stuck'].includes(j.state)
            || (j.state === 'awaiting' && (j.paySig || j.kind === 'evm' || age > 10 * 60e3));
          if (open && age > 2 * 60e3) due.push({ owner, id: j.id, at: Date.parse(j.at) });
        }
      }
      due.sort((a, b) => a.at - b.at);
      for (const d of due) {
        if (Date.now() - t0 > 25e3) break;                               // one wash can take 25 seconds more; the function has 60
        const cap = captured();
        try { await liveWash(req, cap, { job: d.id }, d.owner); }
        catch (e) { cap.code = 500; console.error('sweep wash', d.id, String((e && e.message) || e).slice(0, 160)); }
        seen.push(d.id.slice(0, 8) + ':' + cap.code + (cap.body && cap.body.live ? ':done' : cap.body && cap.body.waiting ? ':waiting' : ''));
      }
      // prizes that stopped part way: sent (done), or never sent (the claim given back)
      for (const g of ((store.giveaway || {}).log || [])) {
        if (Date.now() - t0 > 40e3) break;
        if (!['pending', 'unconfirmed'].includes(g.state) || Date.now() - Date.parse(g.at) < 3 * 60e3) continue;
        const st = g.signature ? await settleSig(g.signature, g.validUntil || 1).catch(() => null) : 'failed';
        if (st === 'ok') await patchGiftById(g.id, (x) => { if (!['pending', 'unconfirmed'].includes(x.state)) return false; x.state = 'done'; });
        else if (st === 'failed') {
          await patchGiftById(g.id, (x, cur) => {
            if (!['pending', 'unconfirmed'].includes(x.state)) return false;
            if (x.undo) undoClaim(cur, { ...x.undo, error: 'not sent' }); else { x.state = 'failed'; x.error = 'not sent'; }
          });
        }
        if (st) seen.push('prize ' + g.id.slice(0, 8) + ':' + st);
      }
      // NFT claims that stopped part way: sent, or back in the machine to claim again
      for (const [owner, w] of Object.entries(store.wallets || {})) {
        for (const v of (w.vendWins || [])) {
          if (Date.now() - t0 > 45e3 || (v.state !== 'claiming' && v.state !== 'unconfirmed')) continue;
          const settled = await settleWin(owner, v);
          if (!settled) continue;
          await patchWallet(owner, (ww) => {
            const x = (ww.vendWins || []).find((y) => y.id === v.id);
            if (!x || (x.state !== 'claiming' && x.state !== 'unconfirmed')) return false;
            if (settled === 'claimed') { x.state = 'claimed'; x.claimedAt = x.claimedAt || new Date().toISOString(); }
            else { x.state = 'won'; delete x.mint; delete x.signature; delete x.claimAt; delete x.validUntil; }
          });
          seen.push('nft ' + v.id.slice(0, 8) + ':' + settled);
        }
      }
      // a copy of the whole ledger once a day, kept by date
      if (BACKED_UP !== today()) {
        try { await put('laundry/backup/' + today() + '.json', JSON.stringify(store), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false }); }
        catch {}                                                          // today's copy is there already
        BACKED_UP = today();
      }
      const old = due.filter((d) => Date.now() - d.at > 30 * 60e3).length;
      if (old) console.error('sweep: washes still open after 30 minutes:', old);
      console.log('sweep', JSON.stringify({ due: due.length, seen, ms: Date.now() - t0 }));
      return res.status(200).json({ due: due.length, seen });
    }

    if (q === 'icon') {
      const mint = String(req.query.mint || '');
      if (!isMint(mint)) return res.status(400).end();
      const ic = await iconFor(mint).catch(() => null);
      if (!ic) return res.status(404).end();
      res.setHeader('Content-Type', ic.type);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return res.status(200).send(ic.buf);
    }

    // ---- the commitment: a fresh seed for this wallet's next wash ----
    // Only its hash goes out now. The seed itself is revealed with the result,
    // so the player can check the wash was drawn from what was promised.
    if (q === 'commit') {
      const owner = ownerFromSession(req);
      if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
      const seed = crypto.randomBytes(32).toString('hex');
      let round = null;
      const ok = await patchLedger('commit', (store) => {
        const w = store.wallets[owner] = store.wallets[owner] || newWallet();
        w.round = round = { seed, hash: seedHash(seed), nonce: (w.round?.nonce || 0) + 1, at: Date.now(), game: 'laundry' };
        return w;
      });
      if (!ok) return res.status(409).json({ error: 'Busy, press Swap again' });
      return res.status(200).json({ hash: round.hash, nonce: round.nonce });
    }

    // ---- proof: the latest live washes, each with its payment and payout on Solana ----
    if (q === 'recent') {
      const data = await cached('recent', 20e3, async () => {
        const { store } = await loadAt();
        const rows = [];
        for (const [owner, w] of Object.entries(store.wallets || {})) {
          for (const j of (w.laundry || [])) {
            if (j.v !== 2 || !['done', 'refunded'].includes(j.state)) continue;
            rows.push({ at: j.at, owner: owner.slice(0, 4) + '\u2026' + owner.slice(-4), state: j.state, in: j.in, amount: j.amount,
              mint: j.mint, mult: j.result ? j.result.cycle.mult : null, out: j.result ? j.result.out : null,
              symbol: j.result ? j.result.token.symbol : null, pay: j.kind === 'evm' ? null : (j.paySig || null), sent: j.outSig || null, refund: j.refund || null,
              ...(j.kind === 'evm' ? { payUrl: j.evmTx ? EVM[j.chain].explorer + '/tx/' + j.evmTx : null, inSymbol: j.inSymbol, inDecimals: j.inDecimals } : {}) });
          }
        }
        rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        const washes = rows.slice(0, 12);
        for (const r of washes) {
          if (String(r.in).startsWith('evm:')) {
            const [, key, token] = r.in.split(':'), c = EVM[key];
            r.paid = Number(r.amount) / 10 ** (token ? r.inDecimals || 18 : 18); r.inSymbol = (token ? r.inSymbol || 'token' : c.sym) + ' on ' + c.name;
            delete r.inDecimals; continue;
          }
          const t = await tokenByMint(r.in).catch(() => null);
          r.paid = t ? Number(r.amount) / 10 ** t.decimals : null; r.inSymbol = t ? (r.in === SOL_MINT ? 'SOL' : t.symbol) : '';
        }
        let laundry = null;
        try { laundry = (await washer()).publicKey.toBase58(); } catch {}
        return { laundry, balance: laundry ? await washBalance() : null, count: rows.length, washes };
      });
      return res.status(200).json(data);
    }

    // ---- lucky socks ----
    if (q === 'ref') {
      const owner = ownerFromSession(req);
      if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
      const box = req.method === 'POST' ? (await readPops(owner)).box : null;
      const { store, tag } = await loadAt();
      const w = store.wallets[owner] = store.wallets[owner] || newWallet();
      store.refCodes = store.refCodes || {};
      const code = refCode(owner);
      if (req.method !== 'POST') {
        if (store.refCodes[code] !== owner) { store.refCodes[code] = owner; try { await saveAt(store, tag); } catch {} }
        return res.status(200).json(socksInfo(owner, w));
      }
      // a friend signing in through a link
      const given = String(body.code || '');
      const inviter = /^[A-Za-z0-9]{8}$/.test(given) && Object.hasOwn(store.refCodes, given) ? store.refCodes[given] : null;
      const no = (why) => res.status(200).json({ bonus: 0, why });
      if (!inviter || inviter === owner) return no('That link is not one we know.');
      if (w.referredBy) return no('This wallet already came in through a link.');
      if ((w.laundry || []).length) return no('Links are for wallets new to the laundry.');
      const d = today(), ip = ipKey(req);
      store.refDays = store.refDays || {};
      const day = store.refDays[d] = store.refDays[d] || { ips: {}, by: {} };
      if (day.ips[ip]) return no('One link a day for each connection.');
      if ((day.by[inviter] || 0) >= SOCKS.perDay) return no('That link is full for today.');
      const inv = store.wallets[inviter] = store.wallets[inviter] || { staked: {}, detail: {}, accrued: 0 };
      starterFor(w, box); takePops(w, box);
      w.referredBy = inviter; w.pops = Math.min(9999, (w.pops || 0) + SOCKS.join);
      inv.pops = Math.min(9999, (inv.pops || 0) + SOCKS.join); inv.refJoined = (inv.refJoined || 0) + 1;
      day.ips[ip] = 1; day.by[inviter] = (day.by[inviter] || 0) + 1;
      for (const k of Object.keys(store.refDays).sort().slice(0, -3)) delete store.refDays[k];
      try { await saveAt(store, tag); } catch { return res.status(409).json({ error: 'busy' }); }
      return res.status(200).json({ bonus: SOCKS.join, pops: w.pops, swap: SOCKS.swap });
    }

    // ---- the vending machine ----
    if (q === 'vcommit') {
      const owner = ownerFromSession(req);
      if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
      const seed = crypto.randomBytes(32).toString('hex');
      let round = null;
      const ok = await patchLedger('vcommit', (store) => {
        const w = store.wallets[owner] = store.wallets[owner] || newWallet();
        w.vendRound = round = { seed, hash: seedHash(seed), nonce: (w.vendRound?.nonce || 0) + 1, at: Date.now() };
        return w;
      });
      if (!ok) return res.status(409).json({ error: 'Busy, press Pull again' });
      return res.status(200).json({ hash: round.hash, nonce: round.nonce });
    }
    if (q === 'vend' && req.method === 'POST') {
      const owner = ownerFromSession(req);
      if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
      const clientSeed = String(body.clientSeed || '').slice(0, 64) || 'g00b';
      const ip = ipKey(req);
      // Read before the write: the wallet's pops file, and the machine itself,
      // fresh from the chain, so no NFT is promised that the machine lacks.
      const { box } = await readPops(owner);
      const stockNow = (await vendStock().catch(() => [])).length ? await vendStock(true, true).catch(() => null) : null;
      let reply = null, out = null;
      const saved = await patchLedger('vend', (store) => {
        const w = store.wallets[owner];
        if (!w) { reply = [409, { error: 'The machine reset, press Pull again', recommit: true }]; return false; }
        takePops(w, box);
        if ((w.pops || 0) < VEND.price) { reply = [400, { error: 'Pop ' + (VEND.price - (w.pops || 0)) + ' more bubbles to pull.', pops: w.pops || 0 }]; return false; }
        if (!w.vendRound?.seed) { reply = [409, { error: 'The machine reset, press Pull again', recommit: true }]; return false; }
        const d = today();
        store.vendDays = store.vendDays || {};
        const day = store.vendDays[d] || { nfts: 0, ips: {} };
        const inMachine = stockNow ? stockNow.length - openWins(store) : 0;
        const canWin = inMachine > 0 && day.nfts < VEND_LIMITS.perDay && w.vendWinDay !== d && (day.ips[ip] || 0) < VEND_LIMITS.perIpDay;
        const giftDue = (store.vendGiftRound || 0) < VEND_GIFT_ROUND;
        const { seed, hash, nonce } = w.vendRound;
        w.vendRound = { nonce };                                   // the seed is spent whatever happens next
        const drawn = vendDraw(seed, clientSeed, nonce, canWin);
        // A house gift makes this pull a g00b whatever the draw said. It is marked
        // as a gift in what comes back, so the draw itself still checks out.
        const gift = giftDue && inMachine > 0;
        const pull = gift ? { kind: 'nft', slot: VEND.nftSlots[crypto.randomInt(VEND.nftSlots.length)] } : drawn;
        if (gift) store.vendGiftRound = VEND_GIFT_ROUND;
        w.pops = (w.pops || 0) - VEND.price;
        if (pull.kind === 'candy') w.candy = candyOf(w) + 1;
        const id = crypto.randomUUID();
        (w.vendPulls = w.vendPulls || []).unshift({ id, at: new Date().toISOString(), kind: pull.kind, slot: pull.slot, nonce, hash, ...(gift ? { gift: true } : {}) });
        if (w.vendPulls.length > 30) w.vendPulls.length = 30;
        if (pull.kind === 'nft') {
          (w.vendWins = w.vendWins || []).unshift({ id, at: new Date().toISOString(), state: 'won' });
          const sentWins = w.vendWins.filter((x) => x.state === 'claimed');
          if (sentWins.length > 10) w.vendWins = w.vendWins.filter((x) => x.state !== 'claimed' || sentWins.indexOf(x) < 10);
          w.vendWinDay = d; store.vendDays[d] = { nfts: day.nfts + 1, ips: { ...day.ips, [ip]: (day.ips[ip] || 0) + 1 } };
          for (const k of Object.keys(store.vendDays).sort().slice(0, -7)) delete store.vendDays[k];
        }
        out = { kind: pull.kind, slot: pull.slot, pops: w.pops, candy: candyOf(w), win: pull.kind === 'nft' ? { id } : null,
          fairness: { hash, seed, nonce, clientSeed, canWin, ...(gift ? { gift: true, drew: drawn.kind } : {}) } };
        return w;
      });
      if (reply) return res.status(reply[0]).json(reply[1]);
      if (!saved) return res.status(409).json({ error: 'Busy, press Pull again', recommit: true });
      return res.status(200).json(out);
    }
    // the wallet's NFT wins, so a win can be claimed after a reload
    if (q === 'vwins') {
      const owner = ownerFromSession(req);
      if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
      const { store } = await loadAt();
      return res.status(200).json({ wins: ((store.wallets[owner] || {}).vendWins || []).slice(0, 10) });
    }
    if (q === 'vclaim' && req.method === 'POST') {
      const owner = ownerFromSession(req);
      if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
      const id = String(body.id || '');
      const patchWin = (fn) => patchWallet(owner, (ww) => { const v = (ww.vendWins || []).find((x) => x.id === id); if (v) fn(v); });
      const done = async (win) => ({ claimed: true, mint: win.mint, signature: win.signature, explorer: win.signature ? `https://solscan.io/tx/${win.signature}` : null, ...(await nftCard(win.mint)) });
      let { store, tag } = await loadAt();
      let win = ((store.wallets[owner] || {}).vendWins || []).find((x) => x.id === id);
      if (!win) return res.status(404).json({ error: 'That win was not found.' });
      if (win.state === 'claimed') return res.status(200).json(await done(win));
      // one the server lost track of is settled from the chain before anything else
      if (win.state === 'claiming' || win.state === 'unconfirmed') {
        const settled = await settleWin(owner, win);
        if (!settled) return res.status(202).json({ waiting: true, error: 'Sending, check your wallet in a minute.', explorer: win.signature ? `https://solscan.io/tx/${win.signature}` : null });
        await patchWin((v) => { if (settled === 'claimed') v.state = 'claimed'; else { v.state = 'won'; delete v.mint; delete v.signature; delete v.claimAt; } });
        ({ store, tag } = await loadAt());
        win = store.wallets[owner].vendWins.find((x) => x.id === id);
        if (win.state === 'claimed') { memo.delete('vendstock'); return res.status(200).json(await done(win)); }
      }
      if (win.state !== 'won') return res.status(409).json({ error: 'Busy, press Claim again.' });
      // an NFT the machine holds that no other claim is sending right now
      const busy = new Set();
      for (const x of Object.values(store.wallets)) for (const v of (x.vendWins || [])) if ((v.state === 'claiming' || v.state === 'unconfirmed') && v.mint) busy.add(v.mint);
      const free = (await vendStock(true)).filter((m) => !busy.has(m));
      if (!VEND_SECRET || !free.length) return res.status(200).json({ queued: true, error: 'Your NFT is saved. It sends as soon as the machine is restocked.' });
      const mint = free[crypto.randomInt(free.length)];
      win.state = 'claiming'; win.mint = mint; win.claimAt = Date.now();
      try { await saveAt(store, tag); } catch { return res.status(409).json({ error: 'Busy, press Claim again.' }); }
      const web3 = await import('@solana/web3.js');
      const spl = await import('@solana/spl-token');
      const { buildNftSend } = await import('../laundry-swap.js');
      const conn = mainnetConn(web3);
      const from = await vender();
      let sent;
      try {
        const built = await retry(() => buildNftSend({ conn, web3, spl, from: from.publicKey, to: owner, mint }));
        sent = await sendOnce({ conn, built, signer: from, record: async (sig, valid) => {
          const ok = await patchWallet(owner, (ww) => { const v = (ww.vendWins || []).find((x) => x.id === id); if (v) { v.signature = sig; v.validUntil = valid; } });
          if (!ok) throw new Error('the send could not be recorded');
        } });
      } catch (e) { sent = { status: 'failed' }; }
      if (sent.status === 'failed') {                        // nothing went out, or it cannot land: the win stays open
        await patchWin((v) => { if (v.state === 'claiming') { v.state = 'won'; delete v.mint; delete v.claimAt; delete v.signature; delete v.validUntil; } });
        return res.status(502).json({ error: 'Could not send it just now. Press Claim again.' });
      }
      if (sent.status === 'unknown') {
        await patchWin((v) => { v.state = 'unconfirmed'; });
        return res.status(202).json({ waiting: true, error: 'Sending, check your wallet in a minute.', explorer: `https://solscan.io/tx/${sent.sig}` });
      }
      await patchWin((v) => { v.state = 'claimed'; v.claimedAt = new Date().toISOString(); });
      memo.delete('vendstock');
      return res.status(200).json(await done({ mint, signature: sent.sig }));
    }

    // ---- bubble rewards: pops counted for a connected wallet ----
    // Pops arrive in batches. A batch counts no faster than about three pops a
    // second since the last one, a wallet counts at most 5,000 in a day, and a
    // count stops at 9,999. Once a round, the first time a wallet comes by signed
    // in, its count is set to 200 free bubbles (round 1 was the launch on
    // 2026-09-28; rounds 2 and 3 added 200, round 4 on reset every count to 200).
    if (q === 'pops') {
      const owner = ownerFromSession(req);
      if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
      if (req.method !== 'POST') {
        // shown: the round's free bubbles if due, and the file's pops taken in
        const { box } = await readPops(owner);
        let shown = null;
        const ok = await patchLedger('pops in', (store) => {
          const had = store.wallets[owner];
          if (!had && !bornOk(store, req)) return false;
          const w = store.wallets[owner] = had || newWallet();
          const starter = starterFor(w, box), fresh = takePops(w, box);
          shown = { pops: w.pops || 0, candy: candyOf(w), ...(starter ? { starter: STARTER_POPS } : {}) };
          return starter || fresh || !had ? w : false;
        });
        if (shown) return res.status(200).json(shown);
        const w = (await loadAt()).store.wallets[owner];                // nothing to change, or busy: as it stands
        return res.status(200).json({ pops: popsNow(w, box), candy: w ? candyOf(w) : 0 });
      }
      // counted: into the wallet's own file, at a person's pace
      const n = Math.max(0, Math.min(1000, Math.floor(Number(body.n) || 0)));
      for (let i = 0; i < 4; i++) {
        const { box, tag } = await readPops(owner);
        const now = Date.now(), d = today();
        if (box.day !== d) { box.day = d; box.today = 0; }
        const pace = Math.ceil(Math.max(1000, now - (box.at || now - 60e3)) / 330);
        const add = Math.max(0, Math.min(n, pace, 5000 - (box.today || 0)));
        if (!add) return res.status(200).json({ added: 0 });
        box.total = (box.total || 0) + add; box.today = (box.today || 0) + add; box.at = now;
        try { await writePops(owner, box, tag); return res.status(200).json({ added: add }); }
        catch { await sleep(40 + Math.random() * 160); }
      }
      return res.status(409).json({ error: 'busy' });                   // the page sends them again
    }

    // ---- lucky bubbles: the draw ----
    if (q === 'bubble' && req.method === 'POST') {
      const now = Date.now(), ip = clientIp(req);
      if (now - (lastPop.get(ip) || 0) < GIFT.cooldownMs) return res.status(200).json({ win: false });
      lastPop.set(ip, now);
      if (lastPop.size > 5000) lastPop.clear();
      if (crypto.randomInt(1_000_000) >= GIFT.chance * 1_000_000) return res.status(200).json({ win: false });
      if (!(await giftOn())) return res.status(200).json({ win: false });
      // no point offering what could not be taken
      const { store } = await loadAt(), day = giftDay(store, false), owner = ownerFromSession(req);
      if (owner && store.wallets[owner] && store.wallets[owner].giftDay === today()) return res.status(200).json({ win: false });
      if (day && (day.ips[ipKey(req)] || 0) >= GIFT.perIp) return res.status(200).json({ win: false });
      const cents = giftCents(crypto.randomInt(1e9) / 1e9, crypto.randomInt(1e9) / 1e9);
      if (day && day.usd + cents / 100 > GIFT.dailyUsd) return res.status(200).json({ win: false });
      const coin = GIFTS[crypto.randomInt(GIFTS.length)];
      const ticket = signTicket({ c: cents, k: coin.key, x: now + GIFT.ttlMs, n: crypto.randomBytes(9).toString('base64url') });
      return res.status(200).json({ win: true, usd: cents / 100, coin, ticket });
    }

    // ---- lucky bubbles: taking the prize ----
    if (q === 'gift' && req.method === 'POST') {
      const owner = ownerFromSession(req);
      if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
      const t = readTicket(body.ticket);
      const coin = t && GIFTS.find((g) => g.key === t.k);
      if (!t || !coin || !Number.isInteger(t.c) || t.c < 100 || t.c > 1000 || !t.n) return res.status(400).json({ error: 'That prize ticket is not valid.', gone: true });
      if (!(t.x > Date.now())) return res.status(400).json({ error: 'That bubble dried up. Pop another one.', gone: true });
      if (!GIFT_SECRET) return res.status(503).json({ error: 'The prize jar is closed right now.', gone: true });
      const usd = t.c / 100, d = today(), ip = ipKey(req);

      // The ticket's checks, made again inside the write below, since the ledger
      // can move while the prize is being built.
      const refuse = (store) => {
        const day = giftDay(store, true), w = store.wallets[owner];
        const yday = store.giveaway.days[new Date(Date.now() - 864e5).toISOString().slice(0, 10)];
        if (day.used.includes(t.n) || (yday && yday.used.includes(t.n))) return [409, { error: 'That prize was already taken.', gone: true }];
        if (w && w.giftDay === d) return [400, { error: 'This wallet already took a bubble prize today. Come back tomorrow.', gone: true }];
        if ((day.ips[ip] || 0) >= GIFT.perIp) return [400, { error: 'That is all the bubble prizes for this connection today.', gone: true }];
        if (day.usd + usd > GIFT.dailyUsd + 1e-9) return [400, { error: 'Today\u2019s prizes are all gone. Try again tomorrow.', gone: true }];
        return null;
      };
      const early = refuse((await loadAt()).store);
      if (early) return res.status(early[0]).json(early[1]);

      const web3 = await import('@solana/web3.js');
      const spl = await import('@solana/spl-token');
      const { buildSwap, received } = await import('../laundry-swap.js');
      const conn = mainnetConn(web3);
      const from = await giver();
      const px = await priceOf([SOL_MINT]);
      if (!px(SOL_MINT)) return res.status(503).json({ error: 'Could not price SOL right now. Press Accept to try again.' });
      const lamports = Math.round(usd / px(SOL_MINT) * LAMPORTS);
      const built = await buildSwap({ conn, web3, spl, house: from.publicKey, owner, mint: coin.mint, lamports });
      // the prize, the winner's token account if they have none, a wrapped-SOL
      // account for the swap (handed back at the end) and fees
      const bal = await conn.getBalance(from.publicKey);
      if (bal < lamports + (built.dest.exists ? 0 : ATA_RENT) + ATA_RENT + 300_000 + GIFT.reserve) {
        return res.status(503).json({ error: 'The prize jar is empty right now.', gone: true });
      }

      // Written down before anything is sent, so the ticket can never pay twice.
      // The record keeps what it takes to give the claim back, for the sweeper.
      const job = { id: crypto.randomUUID(), n: t.n, owner, coin: coin.key, mint: coin.mint, usd, lamports,
        at: new Date().toISOString(), state: 'pending' };
      let undo = null, no = null;
      const claimed = await patchLedger('gift', (store) => {
        no = refuse(store);
        if (no) return false;
        const day = giftDay(store, true);
        const w = store.wallets[owner] = store.wallets[owner] || newWallet();
        undo = { d, n: t.n, usd, ip, owner, prevDay: w.giftDay, id: job.id };
        day.used.push(t.n); day.usd = Math.round((day.usd + usd) * 100) / 100; day.wins += 1; day.ips[ip] = (day.ips[ip] || 0) + 1;
        w.giftDay = d;
        const log = store.giveaway.log = store.giveaway.log || [];
        log.unshift({ ...job, undo }); if (log.length > 200) log.length = 200;
        return w;
      });
      if (no) return res.status(no[0]).json(no[1]);
      if (!claimed) return res.status(503).json({ error: 'Busy. Press Accept to try again.' });
      // later changes to this prize's record re-read the ledger first
      const patchGift = (fn) => patchGiftById(job.id, fn);
      let sent;
      try {
        sent = await sendOnce({ conn, built, signer: from, record: async (sig, valid) => {
          if (!(await patchGift((g) => { g.signature = sig; g.validUntil = valid; }))) throw new Error('the prize could not be recorded');
        } });
      } catch (e) { sent = { status: 'failed' }; }
      if (sent.status === 'failed') {
        // It never went out, or cannot land. Take the claim back out.
        await patchGift((g, cur) => undoClaim(cur, { ...undo, error: 'not sent' }));
        return res.status(502).json({ error: 'Could not send it just now. Press Accept to try again.' });
      }
      const signature = sent.sig;
      if (sent.status === 'unknown') {
        await patchGift((g) => { g.state = 'unconfirmed'; });
        return res.status(202).json({ error: 'Sent, still confirming. Check your wallet in a minute.',
          signature, explorer: `https://solscan.io/tx/${signature}` });
      }

      const got = await received({ conn, signature, owner, mint: coin.mint }).catch(() => built.quote.outAmount);
      await patchGift((g) => { g.state = 'done'; g.out = got; });
      const tok = await tokenByMint(coin.mint).catch(() => null);
      return res.status(200).json({ sent: true, usd, coin, out: tok ? Number(got) / 10 ** tok.decimals : null,
        signature, explorer: `https://solscan.io/tx/${signature}` });
    }

    // the signed-in wallet's own tokens, for the top of the picker
    if (q === 'holdings') {
      const owner = ownerFromSession(req);
      if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
      if (req.query.fresh) memo.delete('h:' + owner);               // straight after a wash
      return res.status(200).json({ owner, tokens: await cached('h:' + owner, 30e3, () => holdings(owner)) });
    }

    if (q === 'search') {
      const text = String(req.query.query || '').trim().slice(0, 64);
      if (!text) return res.status(200).json({ tokens: [] });
      const list = await cached('s:' + text.toLowerCase(), 60e3, () => tokenInfo(text));
      return res.status(200).json({ tokens: (Array.isArray(list) ? list : [])
        .filter((t) => t.id !== SOL_MINT).slice(0, 12).map(slim) });
    }

    if (q === 'quote' && evmSide(req.query)) {
      const ev = evmSide(req.query), mint = String(req.query.mint || '');
      if (!isMint(mint)) return res.status(400).json({ error: 'Pick a token' });
      if (!ev.wei) return res.status(400).json({ error: 'Enter an amount' });
      const laundry = (await washer()).publicKey.toBase58();
      let from = evmCoin(ev.key), inAmt = Number(ev.wei) / 1e18;
      const worth = (lamports, error) => res.status(200).json({ noRoute: true, from, inMint: ev.in, amount: ev.wei, in: inAmt, lamports, error });
      let rq;
      try { rq = await relayQuote({ chain: ev.chain, wei: ev.wei, user: EVM_PLACEHOLDER, recipient: laundry, token: ev.token }); }
      catch (e) {
        if (ev.token) {
          // what 0.1 SOL costs in this token says what the amount typed is worth
          const ref = await relayQuote({ chain: ev.chain, wei: '100000000', user: EVM_PLACEHOLDER, recipient: laundry, token: ev.token, exactOut: true }).catch(() => null);
          const need = ref && Number(ref.details.currencyIn.amount), c = (ref && ref.details.currencyIn.currency) || {};
          if (!(need > 0)) return worth(0, 'No way across for that token right now');
          from = { mint: ev.in, evm: ev.key, address: ev.token, symbol: c.symbol || '?', name: (c.name || c.symbol || 'Token') + ' on ' + ev.chain.name, decimals: (Number.isInteger(Number(c.decimals)) ? Number(c.decimals) : 18) };
          inAmt = Number(ev.wei) / 10 ** from.decimals;
          return worth(Math.floor(Number(ev.wei) * 1e8 / need), null);
        }
        // too little to cross: what it is worth comes from a bigger quote, so the page can say the limits
        const ref = ev.key === 'bnb' ? 200000000000000000n : 30000000000000000n;
        const big = await relayQuote({ chain: ev.chain, wei: ref.toString(), user: EVM_PLACEHOLDER, recipient: laundry }).catch(() => null);
        return big ? worth(Math.floor(Number(big.details.currencyOut.amount) * Number(ev.wei) / Number(ref)), null) : worth(0, 'No way across from ' + ev.chain.name + ' right now');
      }
      if (ev.token) {
        const c = rq.details.currencyIn.currency || {};
        from = { mint: ev.in, evm: ev.key, address: ev.token, symbol: c.symbol || '?', name: (c.name || c.symbol || 'Token') + ' on ' + ev.chain.name, decimals: (Number.isInteger(Number(c.decimals)) ? Number(c.decimals) : 18) };
        inAmt = Number(ev.wei) / 10 ** from.decimals;
      }
      const lamports = Number(rq.details.currencyOut.amount);
      let d;
      if (mint === SOL_MINT) {
        const px = await priceOf([SOL_MINT]);
        d = { token: await tokenByMint(SOL_MINT), outAmount: String(lamports), out: lamports / LAMPORTS, outUsd: px(SOL_MINT) ? lamports / LAMPORTS * px(SOL_MINT) : null, priceImpactPct: 0 };
        d.token = { ...d.token, symbol: 'SOL' };
      } else {
        try { d = await describe(SOL_MINT, String(lamports), mint); }
        catch { return worth(lamports, lamports < MIN ? null : 'No route for that pair right now'); }
      }
      const owner = String(req.query.owner || '');
      return res.status(200).json({ ...d, from, inMint: ev.in, amount: ev.wei, in: inAmt, lamports, inUsd: Number(rq.details.currencyIn.amountUsd) || null,
        rate: d.out / inAmt, needsAccount: isMint(owner) && mint !== SOL_MINT ? !(await hasAccount(owner, mint).catch(() => true)) : null,
        bridge: { seconds: rq.details.timeEstimate || null } });
    }

    if (q === 'quote') {
      const mint = String(req.query.mint || ''), { inMint, amount } = paySide(req.query);
      if (!isMint(mint) || mint === inMint) return res.status(400).json({ error: 'Pick a token' });
      if (!amount) return res.status(400).json({ error: 'Enter an amount' });
      const from = await tokenByMint(inMint);
      const lamports = await lamportsOf(inMint, amount, from.decimals);
      const worth = { noRoute: true, from, inMint, amount, in: Number(amount) / 10 ** from.decimals, lamports, error: null };
      if (lamports > 1000 * LAMPORTS) return res.status(200).json(worth);     // far past the limits: no need to ask Jupiter
      let d;
      try { d = await describe(inMint, amount, mint); }
      catch {
        // Too small to route, or no route today. The page still gets what the
        // amount is worth, so it can say the machine's limits instead.
        return res.status(200).json({ ...worth, error: lamports < MIN ? null : 'No route for that pair right now' });
      }
      const owner = String(req.query.owner || '');
      d.needsAccount = isMint(owner) ? !(await hasAccount(owner, mint).catch(() => true)) : null;
      return res.status(200).json(d);
    }

    // ---- live: build the player's payment for their wallet to approve ----
    if (q === 'pay' && req.method === 'POST') {
      if (!LIVE) return res.status(400).json({ error: 'The laundry is in practice mode right now.' });
      const owner = ownerFromSession(req);
      if (!owner) return res.status(401).json({ error: 'Connect your wallet first' });
      if (evmSide(body)) return await payEvm(req, res, body, owner, evmSide(body));
      const mint = String(body.mint || ''), { inMint, amount } = paySide(body);
      const clientSeed = String(body.clientSeed || '').slice(0, 64) || 'g00b';
      if (!isMint(mint) || mint === inMint) return res.status(400).json({ error: 'Pick a token' });
      if (!amount) return res.status(400).json({ error: 'Enter an amount' });
      // the swap fee range the player saw; any range the machine could roll is fine
      const range = validRange(body.range) ? { lo: body.range.lo, hi: body.range.hi } : null;
      if (!range) return res.status(400).json({ error: 'Reload the page to get a swap fee range.' });
      const top = await maxNow();
      const worth = await lamportsOf(inMint, amount, (await tokenByMint(inMint)).decimals);
      if (!(worth >= MIN) || worth > top) {
        return res.status(400).json({ error: `Washes run from ${MIN / LAMPORTS} to ${top / LAMPORTS} SOL` + (inMint === SOL_MINT ? '' : ' worth') });
      }
      // Everything slow (chain lookups, building the payment) happens before the
      // write, and the write itself is short and tried again when another write
      // got there first, so a busy ledger does not turn Swap away.
      const first = (await loadAt()).store.wallets[owner];
      if (!first?.round?.seed || first.round.game !== 'laundry') return res.status(409).json({ error: 'The machine reset, press Swap again', recommit: true });
      const laundryKey = (await washer()).publicKey.toBase58();
      // An unpaid wash lapses once its payment can no longer land (ten minutes is
      // well past a blockhash's life), but only after checking the chain for it;
      // one whose payment turns up is kept, with its payment, for the sweeper.
      const looked = {};
      for (const j of first.laundry || []) {
        if (j.v === 2 && j.kind !== 'evm' && j.state === 'awaiting' && !j.paySig && Date.now() - Date.parse(j.at) > 10 * 60e3) {
          looked[j.id] = await findPayment(laundryKey, memoFor(j.id), Date.parse(j.at)).catch(() => undefined);
        }
      }
      const web3 = await import('@solana/web3.js');
      const { buildPay } = await import('../laundry-swap.js');
      const conn = mainnetConn(web3);
      const id = crypto.randomUUID();
      // the public RPC turns busy callers away now and then; one more try is usually enough
      const pay = await retry(() => buildPay({ conn, web3, owner, laundry: laundryKey, inMint, amount, memo: memoFor(id) }));
      if (pay.lamports < MIN) return res.status(400).json({ error: 'Add a little more: that swap could come in under ' + MIN / LAMPORTS + ' SOL.' });
      if (pay.lamports > top) return res.status(400).json({ error: `Washes run from ${MIN / LAMPORTS} to ${top / LAMPORTS} SOL worth` });
      let reply = null, round = null;
      const saved = await patchLedger('pay', (store) => {
        const w = store.wallets[owner];
        if (!w?.round?.seed || w.round.game !== 'laundry' || w.round.hash !== first.round.hash) { reply = [409, { error: 'The machine reset, press Swap again', recommit: true }]; return false; }
        for (const j of w.laundry || []) {
          if (j.state !== 'awaiting' || j.paySig || !(j.id in looked)) continue;
          if (looked[j.id] === null) { j.state = 'expired'; j.error = 'The payment never arrived, so nothing was taken.'; }
          else if (looked[j.id]) j.paySig = looked[j.id];
        }
        if ((w.laundry || []).filter(liveJob).length >= 3) { reply = [429, { error: 'Finish your last wash first, or give it a few minutes.' }]; return false; }
        // the commitment moves onto the wash, so the cycle was fixed before the player paid
        round = w.round;
        w.round = { nonce: round.nonce };
        (w.laundry = w.laundry || []).unshift({ id, v: 2, in: inMint, amount, mint, expect: pay.lamports, seed: round.seed, hash: round.hash, nonce: round.nonce,
          clientSeed, range, payValid: pay.lastValidBlockHeight, at: new Date().toISOString(), state: 'awaiting' });
        trimJobs(w);
        return w;
      });
      if (reply) return res.status(reply[0]).json(reply[1]);
      if (!saved) return res.status(503).json({ error: 'The laundry is busy. Press Swap again.' });
      return res.status(200).json({ job: id, tx: Buffer.from(pay.tx.serialize()).toString('base64'), lamports: pay.lamports, hash: round.hash, nonce: round.nonce });
    }

    if (q === 'wash' && req.method === 'POST') {
      // a live wash is finished against the payment the player approved
      if (body.job) {
        let code = 200;
        const status = res.status.bind(res), json = res.json.bind(res);
        res.status = (c) => { code = c; return status(c); };
        // Over means paid out (live), refunded, or ended with nothing taken (400,
        // or 404 for a wash that is not there). A jam of the laundry's own (a 5xx)
        // is never over: the page keeps the wash and asks again.
        res.json = (d) => json(!(d && d.waiting) && (code === 400 || code === 404 || (d && d.refunded)) ? { ...d, final: true } : d);
        return await liveWash(req, res, body);
      }
      if (LIVE) return res.status(400).json({ error: 'Reload the page to use the laundry.' });

      // ---- practice: a real draw on a fresh seed, revealed at once, nothing moves ----
      if (evmSide(body)) return res.status(400).json({ error: 'Paying from another chain works when the laundry is live.' });
      const mint = String(body.mint || ''), { inMint, amount } = paySide(body);
      const clientSeed = String(body.clientSeed || '').slice(0, 64) || 'g00b';
      if (!isMint(mint) || mint === inMint) return res.status(400).json({ error: 'Pick a token' });
      if (!amount) return res.status(400).json({ error: 'Enter an amount' });
      const range = validRange(body.range) ? { lo: body.range.lo, hi: body.range.hi } : null;
      if (!range) return res.status(400).json({ error: 'Reload the page to get a swap fee range.' });
      const lamports = await lamportsOf(inMint, amount, (await tokenByMint(inMint)).decimals);
      if (!(lamports >= MIN) || lamports > MAX) {
        return res.status(400).json({ error: `Washes run from ${MIN / LAMPORTS} to ${MAX / LAMPORTS} SOL` + (inMint === SOL_MINT ? '' : ' worth') });
      }
      const seed = crypto.randomBytes(32).toString('hex');
      const cycle = washCycle(seed, clientSeed, 0, range);
      const washed = (BigInt(amount) * BigInt(Math.round(cycle.mult * 1e6)) / 1_000_000n).toString();
      const d = await describe(inMint, washed, mint);
      return res.status(200).json({ practice: true, cycle, lamports, amount, washed, result: d,
        fairness: { hash: seedHash(seed), seed, nonce: 0, clientSeed, range } });
    }

    return res.status(404).json({ error: 'No such route' });
  } catch (e) {
    console.error('laundry', q, String((e && e.stack) || e).slice(0, 500));
    return res.status(502).json({ error: 'The machine jammed. Try again.' });
  }
}
