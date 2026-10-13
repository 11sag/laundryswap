// The dryer: staking, borrowing and a 1.5x boost, each built here as ONE
// transaction for the player's own wallet to approve. The laundry never holds
// the money and never signs: a stake account belongs to the player's wallet,
// and a Kamino position belongs to it too.
//
//   GET  ?q=info          rates, prices and limits for the page (anyone)
//   GET  ?q=mine          the signed-in wallet's stakes and Kamino positions
//   POST ?q=build {op}    one unsigned transaction for the signed-in wallet;
//                         it is tried against the network first, so a player is
//                         never asked to approve one that would fail
//   POST ?q=send {signed} sends a transaction the wallet signed but did not send
//   GET  ?q=status&sig=   whether a sent transaction landed
//
// The rules (which coins, how far a borrow may go, the boost's size) are in
// dryer-core.js, which the page reads too.

import crypto from 'crypto';
import { Connection, PublicKey, StakeProgram, SystemProgram, Authorized, Lockup, Transaction, ComputeBudgetProgram, VersionedTransaction } from '@solana/web3.js';
import { KAMINO_MARKET, USDC_MINT, BORROW_COINS, BOOST_COINS, DEBT_SYM, LEVERAGE, BOOST_SLIPPAGE, KEEP_SOL, FEE_PCT, FEE_WALLET, PRIZE_MIN_USD, feeLamports, liqPrice, riskOf, borrowRoomFrom } from '../dryer-core.js';

const AUTH_SECRET = process.env.AUTH_SECRET || '';
// Laundry Swap's fee: the rate (dryer-core.js, or DRYER_FEE_PCT) and where it goes
const FEE_ENV = Number(process.env.DRYER_FEE_PCT);
const FEE_RATE = process.env.DRYER_FEE_PCT && Number.isFinite(FEE_ENV) && FEE_ENV >= 0 && FEE_ENV <= 1 ? FEE_ENV : FEE_PCT;
export const FEE_TO = process.env.DRYER_FEE_WALLET || FEE_WALLET;
const NETWORK = process.env.SOLANA_NETWORK || 'devnet';
// The paid Solana node first when one is set (its address carries a key and is
// never logged), the public one otherwise.
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const RPC = String(process.env.MAINNET_RPC_URL || '').trim() || PUBLIC_RPC;
// Reads move on to the public node when the paid one turns them away (busy,
// out of credit, a bad key) or fails; a send never moves on (see sendSigned).
const READ_RPCS = [...new Set([RPC, PUBLIC_RPC])];
const MOVE_ON = (status) => status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
const LAMPORTS = 1e9;
const STAKE_SPACE = 200;
const STAKE_ID = 'Stake11111111111111111111111111111111111111';
const isAddr = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || ''));

// The staking side's connection, with the same fallback: reads move on from a
// node that refuses or fails; a send moves on only from a node that turned it
// away at the door (it may otherwise have gone out, and a second node refusing
// it would read as "never sent").
async function steadyFetch(_url, init = {}) {
  const send = /"method"\s*:\s*"sendTransaction"/.test(typeof init.body === 'string' ? init.body : '');
  let last;
  for (const u of READ_RPCS) {
    try {
      const r = await fetch(u, { ...init, signal: AbortSignal.timeout(15000) });
      if (send ? [401, 402, 403, 429].includes(r.status) : MOVE_ON(r.status)) { last = r; continue; }
      return r;
    } catch (e) { if (send) throw e; last = e; }
  }
  if (last && typeof last.status === 'number') return last;
  throw last || new Error('no node');
}
let CONN = null;
const conn = () => (CONN ??= new Connection(RPC, { commitment: 'confirmed', fetch: steadyFetch, disableRetryOnRateLimit: true }));

// ---------------- session ----------------
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
// A few calls a minute per wallet (builds ask the network to try them, reads
// ask Kamino and the stake program), and per connection for status.
const HITS = new Map();
function slowDown(key, max = 20) {
  const now = Date.now(), list = (HITS.get(key) || []).filter((t) => now - t < 60e3);
  if (list.length >= max) return true;
  list.push(now); HITS.set(key, list);
  if (HITS.size > 20000) HITS.clear();
  return false;
}
const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

// ---------------- small shared reads ----------------
const kept = new Map();
async function cached(key, ms, fn) {
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v;
  const v = await fn();
  kept.set(key, { at: Date.now(), v });
  return v;
}
// The priority price: the network's recent 75th percentile, kept between 1,000
// and 50,000 micro lamports, so even the biggest dryer transaction pays well
// under 0.0001 SOL of it.
async function priorityPrice(accounts = []) {
  return cached('prio:' + accounts.join(','), 20e3, async () => {
    const f = await conn().getRecentPrioritizationFees(accounts.length ? { lockedWritableAccounts: accounts.map((a) => new PublicKey(a)) } : undefined).catch(() => []);
    if (!f.length) return 10_000;
    const s = f.map((x) => x.prioritizationFee).sort((a, b) => a - b);
    return Math.min(50_000, Math.max(1_000, Math.round(s[Math.floor(s.length * 0.75)] || 0)));
  });
}

// ---------------- staking ----------------
// The validator: Stakewiz's best rated (score 90+, 5% commission or less,
// voting, 100k SOL or more). If Stakewiz is down,
// the network's own list stands in.
async function validator() {
  return cached('validator', 3600e3, async () => {
    try {
      const r = await fetch('https://api.stakewiz.com/validators', { signal: AbortSignal.timeout(12000) });
      const all = await r.json();
      const top = all.filter((v) => !v.delinquent && v.commission <= 5 && (v.wiz_score || 0) >= 90 && v.activated_stake >= 100_000)
        .sort((a, b) => (b.wiz_score || 0) - (a.wiz_score || 0))[0];
      if (top) return { vote: top.vote_identity, apy: typeof top.total_apy === 'number' ? top.total_apy : null };
    } catch {}
    const { current } = await conn().getVoteAccounts();
    const v = current.filter((x) => x.commission <= 5).sort((a, b) => b.activatedStake - a.activatedStake)[20];
    return { vote: v.votePubkey, apy: null };
  });
}
async function stakeMins() {
  return cached('stakemins', 3600e3, async () => {
    const rent = await conn().getMinimumBalanceForRentExemption(STAKE_SPACE);
    const min = await conn().getStakeMinimumDelegation().then((r) => r.value).catch(() => LAMPORTS);
    return { rent, min: Math.max(min, 1) };
  });
}
// The wallet's stake accounts (any whose withdrawer it is) and where each one is.
async function stakesOf(owner) {
  const [list, ep] = await Promise.all([
    conn().getParsedProgramAccounts(StakeProgram.programId, { filters: [{ dataSize: STAKE_SPACE }, { memcmp: { offset: 44, bytes: owner } }] }),
    conn().getEpochInfo(),
  ]);
  const NEVER = '18446744073709551615';
  return list.map(({ pubkey, account }) => {
    const d = account.data.parsed && account.data.parsed.info && account.data.parsed.info.stake && account.data.parsed.info.stake.delegation;
    let status = 'inactive';
    if (d) status = d.deactivationEpoch !== NEVER ? (ep.epoch > Number(d.deactivationEpoch) ? 'inactive' : 'deactivating') : (ep.epoch > Number(d.activationEpoch) ? 'active' : 'activating');
    return { address: pubkey.toBase58(), lamports: account.lamports, status };
  }).sort((a, b) => b.lamports - a.lamports);
}
const legacyTx = async (owner, ixs, units) => {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await priorityPrice() }), ...ixs);
  tx.feePayer = new PublicKey(owner);
  const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  return { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), until: lastValidBlockHeight };
};
async function buildStake(owner, sol) {
  const { rent, min } = await stakeMins();
  const lamports = Math.round(Number(sol) * LAMPORTS);
  if (!(lamports >= min)) return { error: `Stake at least ${min / LAMPORTS} SOL. That's the network's minimum.` };
  const fee = feeLamports(lamports / LAMPORTS, 1, FEE_RATE);
  const bal = await conn().getBalance(new PublicKey(owner));
  if (lamports + fee + rent + KEEP_SOL * LAMPORTS > bal) return { error: 'Not enough SOL for that. Keep a little for fees.' };
  const v = await validator();
  const me = new PublicKey(owner);
  const seed = 'dryer:' + Date.now().toString(36);
  const stake = await PublicKey.createWithSeed(me, seed, StakeProgram.programId);
  const ixs = [
    ...StakeProgram.createAccountWithSeed({ fromPubkey: me, stakePubkey: stake, basePubkey: me, seed, authorized: new Authorized(me, me), lockup: new Lockup(0, 0, PublicKey.default), lamports: lamports + rent }).instructions,
    ...StakeProgram.delegate({ stakePubkey: stake, authorizedPubkey: me, votePubkey: new PublicKey(v.vote) }).instructions,
    ...(fee ? [SystemProgram.transfer({ fromPubkey: me, toPubkey: new PublicKey(FEE_TO), lamports: fee })] : []),
  ];
  // create + delegate simulated at 26,002 units on mainnet (2026-10-11)
  return { ...(await legacyTx(owner, ixs, 60_000)), what: `Stake ${sol} SOL`, prize: 'stake', fee: feeOut(fee) };
}
async function stakeMove(owner, addr, kind) {
  if (!isAddr(addr)) return { error: 'Pick a stake.' };
  const mine = (await stakesOf(owner)).find((s) => s.address === addr);
  if (!mine) return { error: 'That stake isn’t this wallet’s.' };
  const me = new PublicKey(owner), stake = new PublicKey(addr);
  if (kind === 'unstake') {
    if (mine.status === 'deactivating' || mine.status === 'inactive') return { error: 'That stake is already unstaking.' };
    return { ...(await legacyTx(owner, StakeProgram.deactivate({ stakePubkey: stake, authorizedPubkey: me }).instructions, 30_000)), what: 'Unstake' };
  }
  if (mine.status !== 'inactive') return { error: 'That stake isn’t ready to withdraw yet.' };
  return { ...(await legacyTx(owner, StakeProgram.withdraw({ stakePubkey: stake, authorizedPubkey: me, toPubkey: me, lamports: mine.lamports }).instructions, 30_000)), what: 'Withdraw' };
}

// ---------------- Kamino ----------------
// The toolkit is big, so it loads only when a Kamino setting is used.
let K = null;
async function kamino() {
  if (K) return K;
  const [sdk, kit, dec] = await Promise.all([import('@kamino-finance/klend-sdk'), import('@solana/kit'), import('decimal.js')]);
  K = { sdk, kit, Decimal: dec.default, rpc: kit.createSolanaRpcFromTransport(steadyTransport(kit)) };
  return K;
}
// Kamino's loader asks for a lot at once, and a paid node on a small plan
// answers a burst with "too many requests". So: at most four calls at a time,
// each tried on the paid node, then the public one, then again after a pause.
function steadyTransport(kit) {
  const transports = READ_RPCS.map((url) => kit.createDefaultRpcTransport({ url }));
  let busy = 0;
  const line = [];
  const turn = async () => { while (busy >= 4) await new Promise((go) => line.push(go)); busy++; };
  const done = () => { busy--; const next = line.shift(); if (next) next(); };
  const statusOf = (e) => Number((e && e.context && (e.context.statusCode || e.context.__statusCode)) || 0);
  return async (args) => {
    await turn();
    try {
      let last;
      for (let round = 0; round < 4; round++) {
        for (const t of transports) {
          try { return await t({ ...args, signal: AbortSignal.any([args.signal, AbortSignal.timeout(12e3)].filter(Boolean)) }); }
          catch (e) { last = e; const st = statusOf(e); if (st && !MOVE_ON(st)) throw e; }
        }
        await new Promise((w) => setTimeout(w, 250 * 2 ** round));
      }
      throw last;
    } finally { done(); }
  };
}
// One JSON-RPC read the same way: the paid node, then the public one.
async function rpcRead(body) {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const url of READ_RPCS) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        if (MOVE_ON(r.status)) { last = new Error('rpc ' + r.status); continue; }
        return await r.json();
      } catch (e) { last = e; }
    }
    await new Promise((w) => setTimeout(w, 300 * 2 ** round));
  }
  throw last;
}
let MARKET = null, MARKET_AT = 0, MARKET_FULL_AT = 0, LOADING = null, REFRESHING = null;
async function market() {
  const { sdk, kit, rpc } = await kamino();
  if (!MARKET) {
    LOADING ??= sdk.KaminoMarket.load(rpc, kit.address(KAMINO_MARKET), sdk.DEFAULT_RECENT_SLOT_DURATION_MS).finally(() => { LOADING = null; });
    const m = await LOADING;
    if (!m) throw new Error('Kamino market did not load');
    if (!MARKET) { MARKET = m; MARKET_AT = MARKET_FULL_AT = Date.now(); }
    return MARKET;
  }
  if (Date.now() - MARKET_AT > 20e3) {
    REFRESHING ??= (async () => {
      try {
        if (Date.now() - MARKET_FULL_AT > 300e3) { await MARKET.reload(); MARKET_FULL_AT = Date.now(); } else await MARKET.loadReserves();
        MARKET_AT = Date.now();
      } catch (e) { console.warn('dryer: Kamino refresh failed, keeping the last read', String((e && e.message) || e).slice(0, 160)); }
    })().finally(() => { REFRESHING = null; });
    await REFRESHING;
  }
  return MARKET;
}
const reserveOf = async (sym) => {
  const { sdk } = await kamino();
  return (await market()).getReserveBySymbolAndKind(sym, new sdk.FloatRateReserveKind());
};
const coinInfo = (r) => {
  const c = r.state.config;
  return { mint: String(r.getLiquidityMint()), decimals: r.stats.decimals, price: Number(r.getOracleMarketPrice()), maxLtv: c.loanToValuePct / 100, liqLtv: c.liquidationThresholdPct / 100 };
};
// Kamino's own published rates (its API), five minutes at a time.
async function rates() {
  return cached('krates', 300e3, async () => {
    const r = await fetch(`https://api.kamino.finance/kamino-market/${KAMINO_MARKET}/reserves/metrics?env=mainnet-beta`, { signal: AbortSignal.timeout(10000) });
    const out = {};
    for (const x of await r.json()) {
      const s = x.liquidityToken, sup = Number(x.totalSupplyUsd) || 0;
      if (!out[s] || sup > out[s].sup) out[s] = { sup, supplyApy: Number(x.supplyApy) * 100, borrowApy: Number(x.borrowApy) * 100 };
    }
    return out;
  });
}
async function signer(owner) { const { kit } = await kamino(); return kit.createNoopSigner(kit.address(owner)); }
async function hasSetup(owner) {
  const { sdk, kit, rpc } = await kamino();
  const [pda] = await sdk.userMetadataPda(kit.address(owner), sdk.PROGRAM_ID);
  const a = await rpc.getAccountInfo(pda, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }).send();
  return Boolean(a.value);
}
const ledgerNow = async () => { const { sdk, rpc } = await kamino(); return sdk.getCurrentLedgerInstant(rpc); };
// The wallet's Kamino positions in this market: the plain one (Borrow) and any
// 1.5x ones (Boost), each with what it holds, what it owes and where Kamino
// would start selling.
// The accounts the dryer builds on: the plain one (Kamino's vanilla account 0)
// and one 1.5x account per coin (coin against USDC).
async function dryerAccounts(owner) {
  const { sdk, kit } = await kamino();
  const m = await market(), me = kit.address(owner), usdc = kit.address(USDC_MINT);
  const boost = {};
  for (const c of BOOST_COINS) {
    const r = m.getReserveBySymbolAndKind(c.sym, new sdk.FloatRateReserveKind());
    if (r) boost[c.sym] = String(await new sdk.LeverageObligation(r.getLiquidityMint(), usdc, sdk.PROGRAM_ID).toPda(m.getAddress(), me));
  }
  return { borrow: String(await new sdk.VanillaObligation(sdk.PROGRAM_ID).toPda(m.getAddress(), me)), boost };
}
async function positionsOf(owner) {
  const { kit } = await kamino();
  const m = await market();
  const [all, mine] = await Promise.all([m.getAllUserObligations(kit.address(owner), await ledgerNow()), dryerAccounts(owner)]);
  const sym = (reserveAddr) => { const r = m.getReserveByAddress(reserveAddr); return r ? r.symbol : '?'; };
  const dec = (reserveAddr) => { const r = m.getReserveByAddress(reserveAddr); return r ? r.stats.decimals : 6; };
  const shape = (o) => {
    const deposits = [...o.deposits.values()].map((p) => ({ sym: sym(p.reserveAddress), amount: Number(p.amount) / 10 ** dec(p.reserveAddress), usd: Number(p.marketValueRefreshed) }));
    const debtUsd = [...o.borrows.values()].reduce((a, p) => a + Number(p.marketValueRefreshed), 0);
    const debt = [...o.borrows.values()].map((p) => ({ sym: sym(p.reserveAddress), amount: Number(p.amount) / 10 ** dec(p.reserveAddress) }));
    const collUsd = deposits.reduce((a, d) => a + d.usd, 0);
    const st = o.refreshedStats, liqLtv = Number(st.liquidationLtv) || 0;
    const one = deposits.length === 1 ? deposits[0] : null;
    return { address: String(o.obligationAddress), tag: o.obligationTag, deposits, debt, collUsd, debtUsd,
      // Kamino's own numbers: what all its deposits may borrow, and what's owed counted its way
      borrowLimit: Number(st.borrowLimit) || 0, debtAdj: Number(st.userTotalBorrowBorrowFactorAdjusted) || debtUsd, liqLimit: Number(st.borrowLiquidationLimit) || collUsd * liqLtv,
      risk: riskOf(collUsd, debtUsd, liqLtv), liqPrice: one ? liqPrice(one.amount, debtUsd, liqLtv) : null };
  };
  const list = all.filter((o) => o.deposits.size || o.borrows.size).map(shape);
  const boostAt = new Set(Object.values(mine.boost));
  return { borrow: list.find((o) => o.address === mine.borrow) || null, boosts: list.filter((o) => boostAt.has(o.address)), accounts: mine };
}

// Jupiter, for the boost's swap: a quote (the mid price, as the toolkit wants)
// and the swap's instructions, kept small enough to fit beside Kamino's.
const JUP = 'https://lite-api.jup.ag/swap/v1';
const JUP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SETUP_PROGRAMS = new Set(['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', '11111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111']);
// tight: fewer swap accounts, for a second try when the first came out too big
function jupiterFor(owner, decimalsOf, tight = false) {
  const { kit, Decimal, sdk, rpc } = K;
  const toIx = (j) => ({
    programAddress: kit.address(j.programId),
    accounts: j.accounts.map((a) => ({ address: kit.address(a.pubkey), role: a.isSigner ? (a.isWritable ? kit.AccountRole.WRITABLE_SIGNER : kit.AccountRole.READONLY_SIGNER) : (a.isWritable ? kit.AccountRole.WRITABLE : kit.AccountRole.READONLY) })),
    data: Uint8Array.from(Buffer.from(j.data, 'base64')),
  });
  const quoter = async (inp, klendAccounts) => {
    const maxAccounts = Math.max(12, (tight ? 48 : 64) - klendAccounts.length);
    const url = `${JUP}/quote?inputMint=${inp.inputMint}&outputMint=${inp.outputMint}&amount=${inp.inputAmountLamports.floor().toString()}&slippageBps=${Math.round(BOOST_SLIPPAGE * 100)}&maxAccounts=${maxAccounts}&restrictIntermediateTokens=true`;
    const q = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json();
    if (!q.outAmount) throw new Error('no route');
    const priceAInB = new Decimal(q.outAmount).div(10 ** decimalsOf(String(inp.outputMint))).div(new Decimal(q.inAmount).div(10 ** decimalsOf(String(inp.inputMint))));
    return { priceAInB, quoteResponse: q };
  };
  // The toolkit quotes with a buffer, then swaps exactly what it borrowed (or
  // took out): that amount is quoted again, or the swap would try to spend
  // more than came in (Jupiter's 6024, insufficient funds; found 2026-10-12).
  const swapper = async (inp, klendAccounts, quote) => {
    const exact = String(quote.quoteResponse.inAmount) === inp.inputAmountLamports.floor().toString() ? quote : await quoter(inp, klendAccounts);
    const r = await (await fetch(`${JUP}/swap-instructions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ quoteResponse: exact.quoteResponse, userPublicKey: owner, wrapAndUnwrapSol: false, useSharedAccounts: true }) })).json();
    if (!r.swapInstruction) throw new Error('no swap');
    if (r.swapInstruction.programId !== JUP_PROGRAM || (r.setupInstructions || []).some((i) => !SETUP_PROGRAMS.has(i.programId))) throw new Error('unexpected swap');
    const lookupTables = await sdk.getLookupTableAccounts(rpc, (r.addressLookupTableAddresses || []).map((a) => kit.address(a)));
    return [{ preActionIxs: (r.setupInstructions || []).map(toIx), swapIxs: [toIx(r.swapInstruction)], lookupTables, quote: exact }];
  };
  return { quoter, swapper };
}

const budgetIxs = async (units, accounts = []) => {
  const { kit } = await kamino();
  const price = await priorityPrice(accounts.map(String));
  const le = (n, b) => { const o = new Uint8Array(b); let v = BigInt(n); for (let i = 0; i < b; i++) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
  const CB = kit.address('ComputeBudget111111111111111111111111111111');
  return [{ programAddress: CB, accounts: [], data: new Uint8Array([2, ...le(units, 4)]) }, { programAddress: CB, accounts: [], data: new Uint8Array([3, ...le(price, 8)]) }];
};
// One v0 transaction from Kamino's instructions, compressed with Kamino's lookup
// tables (and the swap's), checked for size and tried against the network.
// Laundry Swap's fee: a plain SOL transfer to FEE_TO, in the toolkit's shape
// (System program instruction 2). It goes LAST, so it never moves a flash loan's
// instruction numbers.
async function feeIx(owner, lamports) {
  const { kit } = await kamino();
  const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(lamports), 4);
  return { programAddress: kit.address('11111111111111111111111111111111'), data: new Uint8Array(data),
    accounts: [{ address: kit.address(owner), role: kit.AccountRole.WRITABLE_SIGNER, signer: await signer(owner) }, { address: kit.address(FEE_TO), role: kit.AccountRole.WRITABLE }] };
}
const solUsd = async () => Number((await reserveOf('SOL')).getOracleMarketPrice());
const feeOut = (lamports) => (lamports ? { lamports, sol: lamports / LAMPORTS } : null);
// One-time rent for Kamino's accounts, kept back from SOL put in: a first loan
// (its account, the user record, token accounts) and a first boost (its account).
const FIRST_LOAN_SOL = 0.04, FIRST_BOOST_SOL = 0.03;
// Whether the wallet's SOL covers what goes in (when it's SOL), the fee, any
// first-time accounts, and a little for the network.
async function solShort(owner, inLamports, fee, extraSol = 0) {
  const bal = await conn().getBalance(new PublicKey(owner));
  if (bal < inLamports) return 'Not enough SOL for that.';
  const need = inLamports + fee + Math.round((extraSol + 0.003) * LAMPORTS);
  if (bal >= need) return null;
  if (extraSol) return `Not enough SOL. A first one needs about ${(extraSol + fee / LAMPORTS).toFixed(3)} SOL more for one-time account setup and the fee.`;
  return `Not enough SOL for the fee (${(fee / LAMPORTS).toFixed(4)} SOL).`;
}
async function finishV0(owner, ixs, extraTables = []) {
  const { kit, sdk, rpc } = await kamino();
  const me = await signer(owner);
  const tables = {};
  for (const t of extraTables) tables[t.address] = t.data.addresses;
  const accounts = [...new Set(ixs.flatMap((i) => [String(i.programAddress), ...(i.accounts || []).map((a) => String(a.address))]))];
  let lutsOk = false;
  for (let i = 0; i < 2 && !lutsOk; i++) {
    try {
      const fm = await (await fetch('https://api.kamino.finance/luts/find-minimal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addresses: accounts }), signal: AbortSignal.timeout(8000) })).json();
      if (!Array.isArray(fm.lutAddresses)) throw new Error('no tables');
      for (const t of await sdk.getLookupTableAccounts(rpc, fm.lutAddresses.map((a) => kit.address(a)))) tables[t.address] = t.data.addresses;
      lutsOk = true;
    } catch {}
  }
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = kit.pipe(kit.createTransactionMessage({ version: 0 }), (m) => kit.setTransactionMessageFeePayerSigner(me, m), (m) => kit.setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => kit.appendTransactionMessageInstructions(ixs, m), (m) => kit.compressTransactionMessageUsingAddressLookupTables(m, tables));
  const b64 = kit.getBase64EncodedWireTransaction(kit.compileTransaction(msg));
  if (Buffer.from(b64, 'base64').length > 1232) return { error: lutsOk ? 'That’s too big for one transaction. Try a different amount.' : 'Busy right now. Try again in a minute.', tooBig: true };
  return { tx: b64, until: Number(bh.lastValidBlockHeight) };
}
// Tries a transaction against the network as the player (signatures not
// checked) and turns a refusal into words.
const WALLET_PROGRAMS = '(11111111111111111111111111111111|TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)';
async function tryIt(b64, op) {
  const j = await rpcRead({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [b64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }] }).catch(() => ({ error: true }));
  if (j.error || !j.result) return { error: 'Couldn’t check that with the network. Try again.', kind: 'other' };
  const v = j.result.value;
  if (!v.err) return { ok: true, units: v.unitsConsumed };
  const logs = (v.logs || []).join(' '), text = logs + ' ' + JSON.stringify(v.err);
  console.warn('dryer: simulation refused', op, JSON.stringify(v.err).slice(0, 120), logs.slice(-300));
  // Kamino's reserve has lent out about all it may (not the player's doing)
  if (/BorrowLimitExceeded|InsufficientLiquidity|BorrowingAboveUtilization|Cannot borrow above borrow limit/i.test(text)) return { error: 'There isn’t that much USDC to borrow right now. Try a smaller amount, or later.', kind: 'limit' };
  // only the wallet's own programs running short means the wallet is short
  if (/insufficient lamports/i.test(text) || new RegExp('Program ' + WALLET_PROGRAMS + ' failed: (custom program error: 0x1\\b|insufficient funds)', 'i').test(text)) return { error: 'Not enough in your wallet for that, plus fees.', kind: 'wallet' };
  if (/Slippage|0x1771|0x1788/i.test(text)) return { error: 'Prices moved. Try again.', kind: 'swap' };
  if (/WorseLtv|Unhealthy|BorrowTooLarge|NetValueRemainingTooSmall|LiquidationThreshold/i.test(text)) return { error: op === 'repay' ? 'That takes out too much while you still owe. Pay some back first.' : 'That borrows too much for what’s put in.', kind: 'limit' };
  return { error: 'The network wouldn’t accept that right now. Try again in a minute.', kind: 'other' };
}
const stripBudget = (ixs) => ixs.filter((i) => String(i.programAddress) !== 'ComputeBudget111111111111111111111111111111');

async function buildSetup(owner) {
  const { sdk, kit } = await kamino();
  if (await hasSetup(owner)) return { error: 'Your loan account is already set up.' };
  const [, groups] = await sdk.getUserLutAddressAndSetupIxs(await market(), await signer(owner), kit.none(), false);
  return finishV0(owner, [...(await budgetIxs(200_000)), ...stripBudget(groups[0] || [])]);
}
const units = (n, decimals) => {
  const s = String(n || '').trim();
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return (BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
};
async function buildBorrow(owner, b) {
  const { sdk } = await kamino();
  const coin = BORROW_COINS.find((c) => c.sym === b.coin);
  if (!coin) return { error: 'Pick a coin.' };
  const [r, usdc] = await Promise.all([reserveOf(coin.sym), reserveOf(DEBT_SYM)]);
  const info = coinInfo(r);
  const put = units(b.amount || '0', info.decimals); let get = units(b.usdc || '0', 6);
  if (put === null || get === null || (put === '0' && get === '0')) return { error: 'Enter an amount.' };
  // never past the dryer's cap: Kamino's own limit for what's already in, plus what's put in now
  const { borrow } = await positionsOf(owner);
  const room = borrowRoomFrom((borrow ? borrow.borrowLimit : 0) + Number(put) / 10 ** info.decimals * info.price * info.maxLtv, borrow ? borrow.debtAdj : 0);
  let clamped = false;
  if (Number(get) / 1e6 > room + 0.005) {
    // "Most" figured on the page a moment ago can sit a hair over after a price tick: borrow the most instead
    if (Number(get) / 1e6 > room * 1.02 + 0.01 || room < 1) return { error: 'That borrows too much for what’s put in.' };
    get = String(Math.floor(room * 1e6)); clamped = true;
  }
  const fee = get !== '0' ? feeLamports(Number(get) / 1e6 * Number(usdc.getOracleMarketPrice()), await solUsd(), FEE_RATE) : 0;
  const short = await solShort(owner, coin.sym === 'SOL' ? Number(put) : 0, fee, borrow ? 0 : FIRST_LOAN_SOL);
  if (short) return { error: short };
  const m = await market(), me = await signer(owner), ledger = await ledgerNow();
  const obligation = new sdk.VanillaObligation(sdk.PROGRAM_ID);
  const common = { kaminoMarket: m, owner: me, obligation, useV2Ixs: true, scopeRefreshConfig: undefined, includeAtaIxs: true, currentLedgerInstant: ledger, initUserMetadata: { skipInitialization: false, skipLutCreation: true } };
  const act = put !== '0' && get !== '0'
    ? await sdk.KaminoAction.buildDepositAndBorrowTxns({ ...common, depositAmount: put, depositReserveAddress: r.address, borrowAmount: get, borrowReserveAddress: usdc.address })
    : put !== '0'
      ? await sdk.KaminoAction.buildDepositTxns({ ...common, amount: put, reserveAddress: r.address })
      : await sdk.KaminoAction.buildBorrowTxns({ ...common, amount: get, reserveAddress: usdc.address });
  const ixs = [...(await budgetIxs(600_000, [usdc.address, r.address])), ...stripBudget(sdk.KaminoAction.actionToIxs(act)), ...(fee ? [await feeIx(owner, fee)] : [])];
  const built = await finishV0(owner, ixs, act.luts.length ? await sdk.getLookupTableAccounts(K.rpc, act.luts) : []);
  if (!built.tx) return built;
  return { ...built, fee: feeOut(fee), ...(clamped ? { usdc: Number(get) / 1e6 } : {}), ...(Number(get) / 1e6 >= PRIZE_MIN_USD ? { prize: 'borrow' } : {}) };
}
async function buildRepay(owner, b) {
  const { sdk } = await kamino();
  const { borrow } = await positionsOf(owner);
  if (!borrow) return { error: 'Nothing borrowed here yet.' };
  const all = (x) => String(x || '').toLowerCase() === 'max';
  const usdc = await reserveOf(DEBT_SYM);
  let pay = all(b.usdc) ? sdk.U64_MAX : units(b.usdc || '0', 6);
  const takeRaw = String(b.amount || '').trim();
  if (takeRaw && !all(takeRaw) && units(takeRaw, 9) === null) return { error: 'Enter an amount.' };
  const wantsTake = all(takeRaw) || Boolean(takeRaw && units(takeRaw, 9) !== '0');
  // the coin matters only when some comes out (a pay back alone works for any collateral)
  const coin = !wantsTake ? null : BORROW_COINS.find((c) => c.sym === b.coin) || BORROW_COINS.find((c) => c.sym === (borrow.deposits[0] || {}).sym);
  if (wantsTake && !coin) return { error: 'Pick a coin.' };
  const r = coin ? await reserveOf(coin.sym) : null;
  const take = !coin ? '0' : all(b.amount) ? sdk.U64_MAX : units(b.amount || '0', r.stats.decimals);
  if (pay === null || take === null || (pay === '0' && take === '0')) return { error: 'Enter an amount.' };
  // only what this account actually owes in USDC, and only a coin it actually holds
  const owedUsdc = (borrow.debt.find((d) => d.sym === DEBT_SYM) || { amount: 0 }).amount;
  if (pay !== '0' && !(owedUsdc > 0)) return { error: 'Nothing borrowed in USDC here.' };
  if (pay === sdk.U64_MAX) {
    // "All" pays off the loan when the wallet has enough (interest keeps adding a little); otherwise what it has
    const accts = await conn().getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(USDC_MINT) }).catch(() => null);
    const have = accts ? accts.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount || '0'), 0n) : null;
    if (have === 0n) return { error: 'No USDC in your wallet to pay back with.' };
    if (have !== null && Number(have) < owedUsdc * 1e6 * 1.0002) pay = have.toString();
  }
  if (take !== '0' && !borrow.deposits.some((d) => d.sym === coin.sym)) return { error: `No ${coin.name} put in here.` };
  if (take !== '0') {
    // while anything is still owed, taking out keeps to the dryer's cap; "All" needs the loan paid off
    const usdcPrice = Number(usdc.getOracleMarketPrice());
    const paid = (pay === sdk.U64_MAX ? owedUsdc : Math.min(Number(pay) / 1e6, owedUsdc)) * usdcPrice;
    const owedAfter = Math.max(0, borrow.debtAdj - paid);
    if (owedAfter > 0.01) {
      if (take === sdk.U64_MAX) return { error: 'Pay it all back to take it all out.' };
      const out = Number(take) / 10 ** r.stats.decimals * Number(r.getOracleMarketPrice()) * coinInfo(r).maxLtv;
      if (owedAfter > borrowRoomFrom(borrow.borrowLimit - out, 0) + 0.005) return { error: 'That takes out too much while you still owe. Pay some back first.' };
    }
  }
  const m = await market(), me = await signer(owner), ledger = await ledgerNow();
  const obligation = await m.getObligationByAddress(K.kit.address(borrow.address));
  const common = { kaminoMarket: m, obligation, useV2Ixs: true, scopeRefreshConfig: undefined, includeAtaIxs: true, currentLedgerInstant: ledger };
  const act = pay !== '0' && take !== '0'
    ? await sdk.KaminoAction.buildRepayAndWithdrawTxns({ ...common, payer: me, repayAmount: pay, repayReserveAddress: usdc.address, withdrawAmount: take, withdrawReserveAddress: r.address })
    : pay !== '0'
      ? await sdk.KaminoAction.buildRepayTxns({ ...common, owner: me, payer: me, amount: pay, reserveAddress: usdc.address })
      : await sdk.KaminoAction.buildWithdrawTxns({ ...common, owner: me, amount: take, reserveAddress: r.address });
  const ixs = [...(await budgetIxs(600_000, [usdc.address, ...(r ? [r.address] : [])])), ...stripBudget(sdk.KaminoAction.actionToIxs(act))];
  return finishV0(owner, ixs, act.luts.length ? await sdk.getLookupTableAccounts(K.rpc, act.luts) : []);
}
async function buildBoost(owner, b, opts = {}) {
  const { sdk, kit, Decimal } = await kamino();
  const coin = BOOST_COINS.find((c) => c.sym === b.coin);
  if (!coin) return { error: 'Pick a coin.' };
  if (!(await hasSetup(owner))) return { needSetup: true };
  const [coll, debt] = await Promise.all([reserveOf(coin.sym), reserveOf(DEBT_SYM)]);
  const amt = Number(b.amount);
  if (!(amt > 0)) return { error: 'Enter an amount.' };
  const m = await market(), me = await signer(owner), ledger = await ledgerNow();
  const decimalsOf = (mint) => (mint === String(coll.getLiquidityMint()) ? coll.stats.decimals : debt.stats.decimals);
  const { quoter, swapper } = jupiterFor(owner, decimalsOf, opts.tight);
  const { boosts, accounts } = await positionsOf(owner);
  const had = boosts.find((x) => x.address === accounts.boost[coin.sym]);
  const obligation = had ? await m.getObligationByAddress(kit.address(had.address)) : null;
  // the cheap checks before Kamino and Jupiter are asked: SOL for what goes in, the fee, and a first boost's accounts
  const usdIn = amt * Number(coll.getOracleMarketPrice());
  const fee = coin.sym === 'SOL' ? feeLamports(amt, 1, FEE_RATE) : feeLamports(usdIn, await solUsd(), FEE_RATE);
  const short = await solShort(owner, coin.sym === 'SOL' ? Math.round(amt * LAMPORTS) : 0, fee, had ? 0 : FIRST_BOOST_SOL);
  if (short) return { error: short };
  // the budget goes in through the toolkit: its flash loan counts instructions
  const out = await sdk.getDepositWithLeverageIxs({
    owner: me, kaminoMarket: m, debtReserveAddress: debt.address, collReserveAddress: coll.address, depositAmount: new Decimal(String(b.amount)),
    priceDebtToColl: debt.getOracleMarketPrice().div(coll.getOracleMarketPrice()), slippagePct: new Decimal(BOOST_SLIPPAGE), obligation, referrer: kit.none(),
    currentLedgerInstant: ledger, targetLeverage: new Decimal(LEVERAGE), selectedTokenMint: coll.getLiquidityMint(), obligationTypeTagOverride: sdk.ObligationTypeTag.Leverage,
    scopeRefreshIx: [], budgetAndPriorityFeeIxs: await budgetIxs(1_000_000, [debt.address, coll.address]), quoteBufferBps: new Decimal(100), quoter, swapper, useV2Ixs: true,
  });
  const best = out[0];
  if (!best) return { error: 'Couldn’t find a route for that. Try a different amount.' };
  const c = best.initialInputs.calcs;
  const built = await finishV0(owner, [...best.ixs, ...(fee ? [await feeIx(owner, fee)] : [])], best.lookupTables);
  if (!built.tx) return built;
  return { ...built, fee: feeOut(fee), plan: { put: amt, holds: Number(c.collTokenToDeposit), borrows: Number(c.debtTokenToBorrow) }, ...(usdIn >= PRIZE_MIN_USD ? { prize: 'boost' } : {}) };
}
async function buildUnboost(owner, b, opts = {}) {
  const { sdk, kit, Decimal, rpc } = await kamino();
  const coin = BOOST_COINS.find((c) => c.sym === b.coin);
  if (!coin) return { error: 'Pick a coin.' };
  const { boosts, accounts } = await positionsOf(owner);
  const had = boosts.find((x) => x.address === accounts.boost[coin.sym]);
  if (!had) return { error: 'No boost on that coin.' };
  const [coll, debt] = await Promise.all([reserveOf(coin.sym), reserveOf(DEBT_SYM)]);
  const m = await market(), me = await signer(owner), ledger = await ledgerNow();
  const obligation = await m.getObligationByAddress(kit.address(had.address));
  const decimalsOf = (mint) => (mint === String(coll.getLiquidityMint()) ? coll.stats.decimals : debt.stats.decimals);
  const { quoter, swapper } = jupiterFor(owner, decimalsOf, opts.tight);
  const deposited = new Decimal(had.deposits.find((d) => d.sym === coin.sym).amount);
  const borrowed = new Decimal((had.debt.find((d) => d.sym === DEBT_SYM) || { amount: 0 }).amount);
  const sol = Number((await rpc.getBalance(kit.address(owner)).send()).value);
  const out = await sdk.getWithdrawWithLeverageIxs({
    owner: me, kaminoMarket: m, debtReserveAddress: debt.address, collReserveAddress: coll.address, obligation, deposited, borrowed, referrer: kit.none(),
    currentLedgerInstant: ledger, withdrawAmount: deposited, priceCollToDebt: coll.getOracleMarketPrice().div(debt.getOracleMarketPrice()), slippagePct: new Decimal(BOOST_SLIPPAGE),
    isClosingPosition: true, selectedTokenMint: coll.getLiquidityMint(), budgetAndPriorityFeeIxs: await budgetIxs(1_000_000, [debt.address, coll.address]), scopeRefreshIx: [], quoteBufferBps: new Decimal(100),
    quoter, swapper, useV2Ixs: true, userSolBalanceLamports: sol,
  });
  if (!out[0]) return { error: 'Couldn’t find a route for that right now. Try again.' };
  return finishV0(owner, out[0].ixs, out[0].lookupTables);
}

// ---------------- soaking: USDC savings in Jupiter's Earn ----------------
// USDC goes in and earns interest; the wallet holds jlUSDC, which grows. Nothing
// is owed and nothing gets sold. Jupiter builds the deposit and the withdrawal.
const EARN = 'https://lite-api.jup.ag/lend/v1/earn';
const EARN_PROGRAM = 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9';
async function soakInfo() {
  return cached('soak', 300e3, async () => {
    const list = await (await fetch(EARN + '/tokens', { signal: AbortSignal.timeout(10000) })).json();
    const t = list.find((x) => x.assetAddress === USDC_MINT);
    return t ? { apy: Number(t.totalRate) / 100, token: t.address } : null;
  });
}
async function soakOf(owner) {
  const d = await (await fetch(EARN + '/positions?users=' + owner, { signal: AbortSignal.timeout(10000) })).json();
  const p = (d || []).find((x) => x.token && x.token.assetAddress === USDC_MINT);
  return p ? { usdc: Number(p.underlyingAssets) / 1e6, shares: p.shares, wallet: Number(p.underlyingBalance) / 1e6 } : { usdc: 0, shares: '0', wallet: 0 };
}
// Jupiter's transaction, with the token account it pays into made first if it isn't there.
async function earnTx(owner, path, body, mint) {
  const j = await (await fetch(EARN + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })).json();
  if (!j.transaction) return { error: 'Couldn’t build that right now. Try again.' };
  const t = Transaction.from(Buffer.from(j.transaction, 'base64'));
  if (t.feePayer && t.feePayer.toBase58() !== owner) return { error: 'That didn’t look right. Nothing was sent.' };
  if (t.instructions.some((i) => ![EARN_PROGRAM, 'ComputeBudget111111111111111111111111111111', ...SETUP_PROGRAMS].includes(i.programId.toBase58()))) return { error: 'That didn’t look right. Nothing was sent.' };
  const me = new PublicKey(owner), m = new PublicKey(mint), TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), ATAP = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const ata = PublicKey.findProgramAddressSync([me.toBuffer(), TOKEN.toBuffer(), m.toBuffer()], ATAP)[0];
  const make = { programId: ATAP, data: Buffer.from([1]), keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true }, { pubkey: me, isSigner: false, isWritable: false }, { pubkey: m, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false }] };
  const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: me, recentBlockhash: blockhash }).add(make, ...t.instructions);
  return { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), until: lastValidBlockHeight };
}
async function buildSoak(owner, b) {
  const amt = units(b.usdc || '0', 6);
  if (!amt || amt === '0') return { error: 'Enter an amount.' };
  const [info, pos] = await Promise.all([soakInfo(), soakOf(owner)]);
  if (!info) return { error: 'Soak isn’t open right now. Try again later.' };
  if (Number(amt) / 1e6 > pos.wallet + 1e-9) return { error: 'You don’t have that much USDC.' };
  const built = await earnTx(owner, 'deposit', { asset: USDC_MINT, signer: owner, amount: amt }, info.token);
  return built.tx ? { ...built, what: 'Soak ' + Number(amt) / 1e6 + ' USDC' } : built;
}
async function buildUnsoak(owner) {
  const pos = await soakOf(owner);
  if (!(pos.usdc > 0) || pos.shares === '0') return { error: 'Nothing soaking yet.' };
  return earnTx(owner, 'redeem', { asset: USDC_MINT, signer: owner, shares: String(pos.shares) }, USDC_MINT);
}

// ---------------- repeat ----------------
// Auto buy: USDC goes into an order on Jupiter's recurring program (on chain, the
// wallet's own), and its keepers buy the coin on a schedule and send each buy
// straight to the wallet. Staked SOL (JupSOL) earns while it sits there. The rest
// can be taken back any time. No fee, no prize.
const RECUR = 'https://lite-api.jup.ag/recurring/v1';
const RECUR_PROGRAM = 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M';
export const REPEAT_COINS = [
  { sym: 'JupSOL', name: 'Staked SOL', mint: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v' },
  { sym: 'cbBTC', name: 'BTC', mint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij' },
  { sym: 'ETH', name: 'ETH', mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' },
];
export const REPEAT_EVERY = { day: 86400, week: 604800, month: 2592000 };
export const REPEAT_TIMES = [4, 8, 12];
export const REPEAT_MIN = 50;                                     // Jupiter's smallest buy, in USDC
// Jupiter's transaction, checked, with a fresh blockhash.
async function recurTx(owner, path, body) {
  const j = await (await fetch(RECUR + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })).json();
  if (!j.transaction) {
    console.warn('dryer: repeat refused', path, String(j.error || j.message || '').slice(0, 160));
    return { error: /minimum/i.test(String(j.error)) ? 'Each buy must be at least $' + REPEAT_MIN + '.' : 'Couldn’t build that right now. Try again.' };
  }
  const t = Transaction.from(Buffer.from(j.transaction, 'base64'));
  if (!t.feePayer || t.feePayer.toBase58() !== owner) return { error: 'That didn’t look right. Nothing was sent.' };
  if (t.instructions.some((i) => ![RECUR_PROGRAM, ...SETUP_PROGRAMS].includes(i.programId.toBase58()))) return { error: 'That didn’t look right. Nothing was sent.' };
  const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: new PublicKey(owner), recentBlockhash: blockhash }).add(...t.instructions);
  return { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), until: lastValidBlockHeight };
}
// The wallet's orders, read from the chain (Jupiter's order list misses some).
// Layout: 8 discriminator, user, input mint, output mint, then u64s: idx,
// next buy (unix s), deposited, withdrawn, out withdrawn, used, out received,
// per buy, every (s).
const COIN_DECIMALS = { JupSOL: 9, cbBTC: 8, ETH: 8 };
async function repeatsOf(owner) {
  const accts = await conn().getProgramAccounts(new PublicKey(RECUR_PROGRAM), { commitment: 'confirmed', filters: [{ dataSize: 289 }, { memcmp: { offset: 8, bytes: owner } }] });
  const out = [];
  for (const { pubkey, account } of accts) {
    const d = account.data;
    if (new PublicKey(d.subarray(40, 72)).toBase58() !== USDC_MINT) continue;
    const c = REPEAT_COINS.find((k) => k.mint === new PublicKey(d.subarray(72, 104)).toBase58());
    if (!c) continue;
    const u = (o) => Number(d.readBigUInt64LE(o));
    const next = u(112), put = u(120), back = u(128), used = u(144), got = u(152), each = u(160), every = u(168);
    const left = put - used - back;
    if (!(each > 0) || left <= 0) continue;
    out.push({ order: pubkey.toBase58(), sym: c.sym, name: c.name, each: each / 1e6, every, times: Math.round(put / each), done: Math.round(used / each), left: left / 1e6, got: got / 10 ** COIN_DECIMALS[c.sym], next: next * 1000 });
  }
  return out.sort((x, y) => x.next - y.next);
}
async function buildRepeat(owner, b) {
  const coin = REPEAT_COINS.find((c) => c.sym === b.coin);
  const every = REPEAT_EVERY[b.every], times = Number(b.times);
  if (!coin || !every || !REPEAT_TIMES.includes(times)) return { error: 'Pick a coin, how often, and how many times.' };
  const amt = units(b.each || '0', 6);
  if (!amt || amt === '0') return { error: 'Enter an amount.' };
  if (Number(amt) / 1e6 < REPEAT_MIN) return { error: 'Each buy must be at least $' + REPEAT_MIN + '.' };
  const total = BigInt(amt) * BigInt(times), pos = await soakOf(owner);
  if (Number(total) / 1e6 > pos.wallet + 1e-9) return { error: 'That needs ' + Number(total) / 1e6 + ' USDC in your wallet.' };
  return recurTx(owner, 'createOrder', { user: owner, inputMint: USDC_MINT, outputMint: coin.mint, params: { time: { inAmount: Number(total), numberOfOrders: times, interval: every, minPrice: null, maxPrice: null, startAt: null } } });
}
async function buildUnrepeat(owner, b) {
  const list = await repeatsOf(owner);
  if (!list.some((o) => o.order === b.order)) return { error: 'That isn’t one of your repeats.' };
  return recurTx(owner, 'cancelOrder', { order: b.order, user: owner, recurringType: 'time' });
}

// ---------------- send everything ----------------
// Empties the wallet into another one the player names (their main wallet):
// coins first, a few accounts per transaction (each emptied account is closed
// and its deposit comes back), then all the SOL in a last one. Stakes, loans
// and boosts don't move; they come out of the dryer first.
const TOKEN_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', ATA_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SEND_PER_TX = 4;
async function buildSendAll(owner, b) {
  let to;
  try { to = new PublicKey(String(b.to || '').trim()); } catch { return { error: 'That isn’t a Solana address.' }; }
  if (!PublicKey.isOnCurve(to.toBytes())) return { error: 'That isn’t a wallet address.' };
  if (to.toBase58() === owner) return { error: 'That’s this same wallet.' };
  const me = new PublicKey(owner), c = conn();
  const lists = await Promise.all([TOKEN_ID, TOKEN22_ID].map((id) => c.getParsedTokenAccountsByOwner(me, { programId: new PublicKey(id) }, 'confirmed')));
  const accts = lists.flatMap((l) => l.value).map(({ pubkey, account }) => {
    const info = account.data.parsed.info;
    return { pubkey, program: new PublicKey(account.owner), mint: new PublicKey(info.mint), amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals, frozen: info.state === 'frozen' };
  // coins to move, and empty classic accounts to close for their deposit (Token-2022 ones can hold fees that block a close)
  }).filter((a) => !a.frozen && (a.amount > 0n || a.program.toBase58() === TOKEN_ID));
  const ixs = [];
  for (const a of accts.slice(0, SEND_PER_TX)) {
    if (a.amount > 0n) {
      const dest = PublicKey.findProgramAddressSync([to.toBuffer(), a.program.toBuffer(), a.mint.toBuffer()], new PublicKey(ATA_ID))[0];
      ixs.push({ programId: new PublicKey(ATA_ID), data: Buffer.from([1]), keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: false }, { pubkey: a.mint, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: a.program, isSigner: false, isWritable: false }] });
      const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(a.amount, 1); data[9] = a.decimals;
      ixs.push({ programId: a.program, data, keys: [{ pubkey: a.pubkey, isSigner: false, isWritable: true }, { pubkey: a.mint, isSigner: false, isWritable: false }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: me, isSigner: true, isWritable: false }] });
    }
    if (a.program.toBase58() === TOKEN_ID) ixs.push({ programId: a.program, data: Buffer.from([9]), keys: [{ pubkey: a.pubkey, isSigner: false, isWritable: true }, { pubkey: me, isSigner: false, isWritable: true }, { pubkey: me, isSigner: true, isWritable: false }] });
  }
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
  if (ixs.length) {
    const tx = new Transaction({ feePayer: me, recentBlockhash: blockhash }).add(...ixs);
    return { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), until: lastValidBlockHeight, more: true, coins: Math.min(accts.length, SEND_PER_TX), coinsLeft: accts.length };
  }
  // last: all the SOL, less the network fee (one signature)
  const bal = await c.getBalance(me, 'confirmed');
  const lamports = bal - 5000;
  if (lamports <= 0) return { error: 'Nothing left to send.', done: true };
  const tx = new Transaction({ feePayer: me, recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: me, toPubkey: to, lamports }));
  return { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), until: lastValidBlockHeight, more: false, sol: lamports / LAMPORTS };
}

// ---------------- prize tickets ----------------
// Staking, a real borrow and a boost earn bubbles and socks, paid by the laundry
// once the transaction is on chain. The ticket names the wallet, the setting,
// the transaction's blockhash and its fee, so it fits that one transaction only.
export const blockhashOf = (b64) => {
  const raw = Buffer.from(b64, 'base64');
  return (raw[1 + 64 * raw[0]] & 0x80) ? VersionedTransaction.deserialize(raw).message.recentBlockhash : Transaction.from(raw).recentBlockhash;
};
export const prizeTicket = (owner, op, b64, fee = 0) => {
  const payload = Buffer.from(JSON.stringify({ o: owner, op, bh: blockhashOf(b64), t: Date.now(), ...(fee ? { f: fee } : {}) })).toString('base64url');
  return payload + '.' + mac('dry:' + payload);
};

// ---------------- sending ----------------
// A wallet that signs without sending hands the signed transaction back here.
// It must be paid for by the signed-in wallet; then it goes out once.
// Only the programs the dryer's own transactions use may be relayed (a signing
// wallet may add Lighthouse's checks or a memo).
const RELAY_PROGRAMS = new Set([...SETUP_PROGRAMS, STAKE_ID, JUP_PROGRAM, 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', 'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr',
  'AddressLookupTab1e1111111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', EARN_PROGRAM, RECUR_PROGRAM]);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => { const d = [0]; for (const b of bytes) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let o = ''; for (const b of bytes) { if (b === 0) o += '1'; else break; } return o + d.reverse().map((x) => B58[x]).join(''); };
async function sendSigned(owner, b64) {
  let payer, programs, sig;
  try {
    const raw = Buffer.from(String(b64 || ''), 'base64');
    if ((raw[1 + 64 * raw[0]] & 0x80)) {
      const m = VersionedTransaction.deserialize(raw).message;
      payer = m.staticAccountKeys[0].toBase58();
      programs = m.compiledInstructions.map((i) => m.staticAccountKeys[i.programIdIndex].toBase58());
    } else {
      const t = Transaction.from(raw);
      payer = t.feePayer.toBase58();
      programs = t.instructions.map((i) => i.programId.toBase58());
    }
    sig = b58(raw.subarray(1, 65));                        // the transaction's own first signature is its id
  } catch { return { status: 400, body: { error: 'That isn’t a transaction.' } }; }
  if (payer !== owner) return { status: 400, body: { error: 'That isn’t this wallet’s transaction.' } };
  if (programs.some((p) => !RELAY_PROGRAMS.has(p))) return { status: 400, body: { error: 'That isn’t a dryer transaction.' } };
  try {
    await conn().sendRawTransaction(Buffer.from(b64, 'base64'), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    return { status: 200, body: { signature: sig } };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/already been processed/i.test(msg)) return { status: 200, body: { signature: sig } };
    // refused before it went out: the network tried it and said no, or its blockhash was too old
    if (/simulation failed|Blockhash not found|signature verification|invalid transaction|insufficient funds/i.test(msg)) {
      console.warn('dryer: send refused', msg.slice(0, 200));
      return { status: 409, body: { error: 'The network wouldn’t accept that. Nothing moved.' } };
    }
    // anything else (a timeout, a node error) may have gone out: the page watches the signature
    console.warn('dryer: send unclear', msg.slice(0, 200));
    return { status: 200, body: { signature: sig, unsure: true } };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = String(req.query.q || '');
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  try {
    if (NETWORK !== 'mainnet' && !process.env.DRYER_ANY_NETWORK) return res.status(200).json({ on: false });

    if (q === 'info') {
      const info = await cached('info', 30e3, async () => {
        const [v, mins, kr] = await Promise.all([validator().catch(() => null), stakeMins().catch(() => null), rates().catch(() => ({}))]);
        const coins = {};
        for (const c of [...new Set([...BORROW_COINS, ...BOOST_COINS].map((x) => x.sym).concat(DEBT_SYM))]) {
          const r = await reserveOf(c).catch((e) => { console.warn('dryer: Kamino unread', c, String((e && e.stack) || e).slice(0, 600)); return null; });
          if (r) coins[c] = { ...coinInfo(r), supplyApy: kr[c] ? kr[c].supplyApy : null };
        }
        return { on: true, stake: { apy: v ? v.apy : null, min: mins ? mins.min : LAMPORTS, rent: mins ? mins.rent : 2282880 },
          coins, usdcBorrowApy: kr[DEBT_SYM] ? kr[DEBT_SYM].borrowApy : null, leverage: LEVERAGE, borrowCoins: BORROW_COINS, boostCoins: BOOST_COINS, fee: FEE_RATE, soak: await soakInfo().catch(() => null),
          repeat: { coins: REPEAT_COINS.map(({ sym, name }) => ({ sym, name })), every: Object.keys(REPEAT_EVERY), times: REPEAT_TIMES, min: REPEAT_MIN } };
      });
      return res.status(200).json(info);
    }

    // where a sent transaction is: confirmed, finalized, failed, or not seen yet
    if (q === 'status') {
      const sig = String(req.query.sig || '');
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return res.status(400).json({ error: 'Bad signature' });
      if (slowDown('status:' + ipOf(req), 120)) return res.status(429).json({ error: 'Slow down a moment.' });
      const { value } = await conn().getSignatureStatuses([sig], { searchTransactionHistory: false });
      const st = value && value[0];
      const until = Number(req.query.until) || 0;
      // not seen, and its blockhash has run out: it never landed, and now it never will
      if (!st && until && (await conn().getBlockHeight('confirmed')) > until) return res.status(200).json({ status: 'expired' });
      return res.status(200).json({ status: !st ? null : st.err ? 'failed' : st.confirmationStatus });
    }

    const owner = ownerFromSession(req);
    if (!owner) return res.status(401).json({ error: 'Connect your wallet first.' });

    if (q === 'mine') {
      if (slowDown('mine:' + owner, 30)) return res.status(429).json({ error: 'Slow down a moment.' });
      const [repeats, soak, stakes, pos, setup] = await Promise.all([repeatsOf(owner).catch(() => null), soakOf(owner).catch(() => null), stakesOf(owner).catch(() => null), positionsOf(owner).catch((e) => { console.warn('dryer: positions unread', String(e && e.message).slice(0, 160)); return null; }), hasSetup(owner).catch(() => null)]);
      return res.status(200).json({ repeats, soak, stakes, stakesUnread: stakes === null, borrow: pos ? pos.borrow : null, boosts: pos ? pos.boosts : null, unread: !pos, setup });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
    if (q === 'send') {
      if (slowDown('send:' + owner, 20)) return res.status(429).json({ error: 'Slow down a moment, then try again.' });
      const r = await sendSigned(owner, body.signed); return res.status(r.status).json(r.body);
    }
    if (q !== 'build') return res.status(404).json({ error: 'Unknown' });
    if (slowDown('build:' + owner)) return res.status(429).json({ error: 'Slow down a moment, then try again.' });

    const op = String(body.op || '');
    const swaps = op === 'boost' || op === 'unboost';
    const build = (opts = {}) => (op === 'stake' ? buildStake(owner, body.sol)
      : op === 'unstake' || op === 'withdrawStake' ? stakeMove(owner, body.stake, op === 'unstake' ? 'unstake' : 'withdraw')
      : op === 'setup' ? buildSetup(owner)
      : op === 'borrow' ? buildBorrow(owner, body)
      : op === 'repay' ? buildRepay(owner, body)
      : op === 'soak' ? buildSoak(owner, body)
      : op === 'unsoak' ? buildUnsoak(owner)
      : op === 'sendall' ? buildSendAll(owner, body)
      : op === 'repeat' ? buildRepeat(owner, body)
      : op === 'unrepeat' ? buildUnrepeat(owner, body)
      : op === 'boost' ? buildBoost(owner, body, opts)
      : op === 'unboost' ? buildUnboost(owner, body, opts)
      : { error: 'Unknown' });
    let built = await build();
    // a swap route too big to fit beside Kamino's: once more with a smaller one
    if (!built.tx && built.tooBig && swaps) built = await build({ tight: true });
    if (!built.tx) { const { tooBig, ...say } = built; return res.status(built.needSetup ? 200 : 400).json(say); }
    // never hand a player a transaction the network would refuse
    let t = await tryIt(built.tx, op);
    // a boost's swap route is Jupiter's pick, and now and then one fails; a second build asks for a fresh route
    if (!t.ok && swaps && (t.kind === 'swap' || t.kind === 'other')) {
      const again = await build();
      if (again.tx) { built = again; t = await tryIt(built.tx, op); }
    }
    if (!t.ok) return res.status(409).json({ error: t.error });
    const { prize, ...rest } = built;
    return res.status(200).json({ ...rest, units: t.units, ...(prize ? { ticket: prizeTicket(owner, prize, built.tx, built.fee ? built.fee.lamports : 0) } : {}) });
  } catch (e) {
    const msg = String((e && e.stack) || e);
    console.error('dryer:', q, msg.slice(0, 400));
    // the network's nodes turning calls away is "busy", not broken
    if (/\b429\b|Too Many Requests|timed? ?out|aborted/i.test(msg)) return res.status(503).json({ error: 'The network is busy. Try again in a minute.' });
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}
