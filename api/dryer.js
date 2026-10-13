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
import { Connection, PublicKey, StakeProgram, Authorized, Lockup, Transaction, ComputeBudgetProgram, VersionedTransaction } from '@solana/web3.js';
import { KAMINO_MARKET, USDC_MINT, BORROW_COINS, BOOST_COINS, DEBT_SYM, LEVERAGE, BOOST_SLIPPAGE, KEEP_SOL, liqPrice, riskOf, borrowRoom } from '../dryer-core.js';

const AUTH_SECRET = process.env.AUTH_SECRET || '';
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
// A few builds a minute per wallet: each one asks the network to try it.
const BUILDS = new Map();
function slowDown(owner) {
  const now = Date.now(), list = (BUILDS.get(owner) || []).filter((t) => now - t < 60e3);
  if (list.length >= 20) return true;
  list.push(now); BUILDS.set(owner, list);
  if (BUILDS.size > 5000) BUILDS.clear();
  return false;
}

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
async function priorityPrice() {
  return cached('prio', 20e3, async () => {
    const f = await conn().getRecentPrioritizationFees().catch(() => []);
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
  tx.recentBlockhash = (await conn().getLatestBlockhash('confirmed')).blockhash;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
};
async function buildStake(owner, sol) {
  const { rent, min } = await stakeMins();
  const lamports = Math.round(Number(sol) * LAMPORTS);
  if (!(lamports >= min)) return { error: `Stake at least ${min / LAMPORTS} SOL. That's the network's minimum.` };
  const bal = await conn().getBalance(new PublicKey(owner));
  if (lamports + rent + KEEP_SOL * LAMPORTS > bal) return { error: 'Not enough SOL for that. Keep a little for fees.' };
  const v = await validator();
  const me = new PublicKey(owner);
  const seed = 'dryer:' + Date.now().toString(36);
  const stake = await PublicKey.createWithSeed(me, seed, StakeProgram.programId);
  const ixs = [
    ...StakeProgram.createAccountWithSeed({ fromPubkey: me, stakePubkey: stake, basePubkey: me, seed, authorized: new Authorized(me, me), lockup: new Lockup(0, 0, PublicKey.default), lamports: lamports + rent }).instructions,
    ...StakeProgram.delegate({ stakePubkey: stake, authorizedPubkey: me, votePubkey: new PublicKey(v.vote) }).instructions,
  ];
  // create + delegate simulated at 26,002 units on mainnet (2026-10-11)
  return { tx: await legacyTx(owner, ixs, 60_000), what: `Stake ${sol} SOL`, prize: 'stake' };
}
async function stakeMove(owner, addr, kind) {
  if (!isAddr(addr)) return { error: 'Pick a stake.' };
  const mine = (await stakesOf(owner)).find((s) => s.address === addr);
  if (!mine) return { error: 'That stake isn’t this wallet’s.' };
  const me = new PublicKey(owner), stake = new PublicKey(addr);
  if (kind === 'unstake') {
    if (mine.status === 'deactivating' || mine.status === 'inactive') return { error: 'That stake is already unstaking.' };
    return { tx: await legacyTx(owner, StakeProgram.deactivate({ stakePubkey: stake, authorizedPubkey: me }).instructions, 30_000), what: 'Unstake' };
  }
  if (mine.status !== 'inactive') return { error: 'That stake isn’t ready to withdraw yet.' };
  return { tx: await legacyTx(owner, StakeProgram.withdraw({ stakePubkey: stake, authorizedPubkey: me, toPubkey: me, lamports: mine.lamports }).instructions, 30_000), what: 'Withdraw' };
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
          try { return await t(args); }
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
let MARKET = null, MARKET_AT = 0;
async function market() {
  const { sdk, kit, rpc } = await kamino();
  if (!MARKET) { MARKET = await sdk.KaminoMarket.load(rpc, kit.address(KAMINO_MARKET), sdk.DEFAULT_RECENT_SLOT_DURATION_MS); MARKET_AT = Date.now(); }
  else if (Date.now() - MARKET_AT > 20e3) { await MARKET.loadReserves(); MARKET_AT = Date.now(); }
  if (!MARKET) throw new Error('Kamino market did not load');
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
async function positionsOf(owner) {
  const { kit } = await kamino();
  const m = await market();
  const all = await m.getAllUserObligations(kit.address(owner), await ledgerNow());
  const sym = (reserveAddr) => { const r = m.getReserveByAddress(reserveAddr); return r ? r.symbol : '?'; };
  const shape = (o) => {
    const deposits = [...o.deposits.values()].map((p) => {
      const r = m.getReserveByAddress(p.reserveAddress);
      return { sym: sym(p.reserveAddress), amount: Number(p.amount) / 10 ** r.stats.decimals, usd: Number(p.marketValueRefreshed) };
    });
    const debtUsd = [...o.borrows.values()].reduce((a, p) => a + Number(p.marketValueRefreshed), 0);
    const debt = [...o.borrows.values()].map((p) => { const r = m.getReserveByAddress(p.reserveAddress); return { sym: sym(p.reserveAddress), amount: Number(p.amount) / 10 ** r.stats.decimals }; });
    const collUsd = deposits.reduce((a, d) => a + d.usd, 0);
    const liqLtv = Number(o.refreshedStats.liquidationLtv) || 0;
    const one = deposits.length === 1 ? deposits[0] : null;
    return { address: String(o.obligationAddress), tag: o.obligationTag, deposits, debt, collUsd, debtUsd, risk: riskOf(collUsd, debtUsd, liqLtv), liqPrice: one ? liqPrice(one.amount, debtUsd, liqLtv) : null };
  };
  const list = all.filter((o) => o.deposits.size || o.borrows.size).map(shape);
  return { borrow: list.find((o) => o.tag === 0) || null, boosts: list.filter((o) => o.tag === 3) };
}

// Jupiter, for the boost's swap: a quote (the mid price, as the toolkit wants)
// and the swap's instructions, kept small enough to fit beside Kamino's.
const JUP = 'https://lite-api.jup.ag/swap/v1';
function jupiterFor(owner, decimalsOf) {
  const { kit, Decimal, sdk, rpc } = K;
  const toIx = (j) => ({
    programAddress: kit.address(j.programId),
    accounts: j.accounts.map((a) => ({ address: kit.address(a.pubkey), role: a.isSigner ? (a.isWritable ? kit.AccountRole.WRITABLE_SIGNER : kit.AccountRole.READONLY_SIGNER) : (a.isWritable ? kit.AccountRole.WRITABLE : kit.AccountRole.READONLY) })),
    data: Uint8Array.from(Buffer.from(j.data, 'base64')),
  });
  const quoter = async (inp, klendAccounts) => {
    const maxAccounts = Math.max(12, 64 - klendAccounts.length);
    const url = `${JUP}/quote?inputMint=${inp.inputMint}&outputMint=${inp.outputMint}&amount=${inp.inputAmountLamports.floor().toString()}&slippageBps=${Math.round(BOOST_SLIPPAGE * 100)}&maxAccounts=${maxAccounts}&restrictIntermediateTokens=true`;
    const q = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json();
    if (!q.outAmount) throw new Error('no route');
    const priceAInB = new Decimal(q.outAmount).div(10 ** decimalsOf(String(inp.outputMint))).div(new Decimal(q.inAmount).div(10 ** decimalsOf(String(inp.inputMint))));
    return { priceAInB, quoteResponse: q };
  };
  const swapper = async (inp, klendAccounts, quote) => {
    const r = await (await fetch(`${JUP}/swap-instructions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ quoteResponse: quote.quoteResponse, userPublicKey: owner, wrapAndUnwrapSol: false, useSharedAccounts: true }) })).json();
    if (!r.swapInstruction) throw new Error('no swap');
    const lookupTables = await sdk.getLookupTableAccounts(rpc, (r.addressLookupTableAddresses || []).map((a) => kit.address(a)));
    return [{ preActionIxs: (r.setupInstructions || []).map(toIx), swapIxs: [toIx(r.swapInstruction)], lookupTables, quote }];
  };
  return { quoter, swapper };
}

const budgetIxs = async (units) => {
  const { kit } = await kamino();
  const price = await priorityPrice();
  const le = (n, b) => { const o = new Uint8Array(b); let v = BigInt(n); for (let i = 0; i < b; i++) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
  const CB = kit.address('ComputeBudget111111111111111111111111111111');
  return [{ programAddress: CB, accounts: [], data: new Uint8Array([2, ...le(units, 4)]) }, { programAddress: CB, accounts: [], data: new Uint8Array([3, ...le(price, 8)]) }];
};
// One v0 transaction from Kamino's instructions, compressed with Kamino's lookup
// tables (and the swap's), checked for size and tried against the network.
async function finishV0(owner, ixs, extraTables = []) {
  const { kit, sdk, rpc } = await kamino();
  const me = await signer(owner);
  const tables = {};
  for (const t of extraTables) tables[t.address] = t.data.addresses;
  const accounts = [...new Set(ixs.flatMap((i) => [String(i.programAddress), ...(i.accounts || []).map((a) => String(a.address))]))];
  try {
    const fm = await (await fetch('https://api.kamino.finance/luts/find-minimal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addresses: accounts }), signal: AbortSignal.timeout(8000) })).json();
    for (const t of await sdk.getLookupTableAccounts(rpc, (fm.lutAddresses || []).map((a) => kit.address(a)))) tables[t.address] = t.data.addresses;
  } catch {}
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = kit.pipe(kit.createTransactionMessage({ version: 0 }), (m) => kit.setTransactionMessageFeePayerSigner(me, m), (m) => kit.setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => kit.appendTransactionMessageInstructions(ixs, m), (m) => kit.compressTransactionMessageUsingAddressLookupTables(m, tables));
  const b64 = kit.getBase64EncodedWireTransaction(kit.compileTransaction(msg));
  if (Buffer.from(b64, 'base64').length > 1232) return { error: 'That’s too big for one transaction. Try a smaller amount.' };
  return { tx: b64 };
}
// Tries a transaction against the network as the player (signatures not
// checked) and turns a refusal into words.
async function tryIt(b64) {
  const j = await rpcRead({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [b64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }] }).catch(() => ({ error: true }));
  if (j.error) return { error: 'Couldn’t check that with the network. Try again.' };
  const v = j.result.value;
  if (!v.err) return { ok: true, units: v.unitsConsumed };
  const logs = (v.logs || []).join(' ');
  console.warn('dryer: simulation refused', JSON.stringify(v.err).slice(0, 120), logs.slice(-300));
  if (/insufficient lamports|insufficient funds|0x1\b|Custom":1\}/i.test(logs + JSON.stringify(v.err))) return { error: 'Not enough in your wallet for that, plus fees.' };
  if (/Slippage|0x1771|ExceededSlippage/i.test(logs)) return { error: 'Prices moved. Try again.' };
  if (/borrow limit|BorrowTooLarge|Unhealthy|WorseLtv/i.test(logs)) return { error: 'That borrows too much for what’s put in.' };
  return { error: 'The network wouldn’t accept that right now. Try again in a minute.' };
}
const stripBudget = (ixs) => ixs.filter((i) => String(i.programAddress) !== 'ComputeBudget111111111111111111111111111111');

async function buildSetup(owner) {
  const { sdk, kit } = await kamino();
  if (await hasSetup(owner)) return { error: 'Your Kamino account is already set up.' };
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
  const put = units(b.amount || '0', info.decimals), get = units(b.usdc || '0', 6);
  if (put === null || get === null || (put === '0' && get === '0')) return { error: 'Enter an amount.' };
  // never past the dryer's cap, with what's already in and already owed
  const { borrow } = await positionsOf(owner);
  const inUsd = Number(put) / 10 ** info.decimals * info.price + (borrow ? borrow.collUsd : 0);
  if (Number(get) / 1e6 > borrowRoom(inUsd, info.maxLtv, borrow ? borrow.debtUsd : 0) + 0.005) return { error: 'That borrows too much for what’s put in.' };
  const m = await market(), me = await signer(owner), ledger = await ledgerNow();
  const obligation = new sdk.VanillaObligation(sdk.PROGRAM_ID);
  const common = { kaminoMarket: m, owner: me, obligation, useV2Ixs: true, scopeRefreshConfig: undefined, includeAtaIxs: true, currentLedgerInstant: ledger, initUserMetadata: { skipInitialization: false, skipLutCreation: true } };
  const act = put !== '0' && get !== '0'
    ? await sdk.KaminoAction.buildDepositAndBorrowTxns({ ...common, depositAmount: put, depositReserveAddress: r.address, borrowAmount: get, borrowReserveAddress: usdc.address })
    : put !== '0'
      ? await sdk.KaminoAction.buildDepositTxns({ ...common, amount: put, reserveAddress: r.address })
      : await sdk.KaminoAction.buildBorrowTxns({ ...common, amount: get, reserveAddress: usdc.address });
  const ixs = [...(await budgetIxs(600_000)), ...stripBudget(sdk.KaminoAction.actionToIxs(act))];
  const built = await finishV0(owner, ixs, act.luts.length ? await sdk.getLookupTableAccounts(K.rpc, act.luts) : []);
  return Number(get) / 1e6 >= PRIZE_MIN_USD ? { ...built, prize: 'borrow' } : built;
}
async function buildRepay(owner, b) {
  const { sdk } = await kamino();
  const { borrow } = await positionsOf(owner);
  if (!borrow) return { error: 'Nothing borrowed here yet.' };
  const coin = BORROW_COINS.find((c) => c.sym === b.coin) || BORROW_COINS.find((c) => c.sym === (borrow.deposits[0] || {}).sym);
  if (!coin) return { error: 'Pick a coin.' };
  const [r, usdc] = await Promise.all([reserveOf(coin.sym), reserveOf(DEBT_SYM)]);
  const all = (x) => String(x || '').toLowerCase() === 'max';
  const pay = all(b.usdc) ? sdk.U64_MAX : units(b.usdc || '0', 6);
  const take = all(b.amount) ? sdk.U64_MAX : units(b.amount || '0', r.stats.decimals);
  if (pay === null || take === null || (pay === '0' && take === '0')) return { error: 'Enter an amount.' };
  // only what this account actually owes in USDC, and only a coin it actually holds
  if (pay !== '0' && !borrow.debt.some((d) => d.sym === DEBT_SYM)) return { error: 'Nothing borrowed in USDC here.' };
  if (take !== '0' && !borrow.deposits.some((d) => d.sym === coin.sym)) return { error: `No ${coin.name} put in here.` };
  const m = await market(), me = await signer(owner), ledger = await ledgerNow();
  const obligation = await m.getObligationByAddress(K.kit.address(borrow.address));
  const common = { kaminoMarket: m, obligation, useV2Ixs: true, scopeRefreshConfig: undefined, includeAtaIxs: true, currentLedgerInstant: ledger };
  const act = pay !== '0' && take !== '0'
    ? await sdk.KaminoAction.buildRepayAndWithdrawTxns({ ...common, payer: me, repayAmount: pay, repayReserveAddress: usdc.address, withdrawAmount: take, withdrawReserveAddress: r.address })
    : pay !== '0'
      ? await sdk.KaminoAction.buildRepayTxns({ ...common, owner: me, payer: me, amount: pay, reserveAddress: usdc.address })
      : await sdk.KaminoAction.buildWithdrawTxns({ ...common, owner: me, amount: take, reserveAddress: r.address });
  const ixs = [...(await budgetIxs(600_000)), ...stripBudget(sdk.KaminoAction.actionToIxs(act))];
  return finishV0(owner, ixs, act.luts.length ? await sdk.getLookupTableAccounts(K.rpc, act.luts) : []);
}
async function buildBoost(owner, b) {
  const { sdk, kit, Decimal } = await kamino();
  const coin = BOOST_COINS.find((c) => c.sym === b.coin);
  if (!coin) return { error: 'Pick a coin.' };
  if (!(await hasSetup(owner))) return { needSetup: true };
  const [coll, debt] = await Promise.all([reserveOf(coin.sym), reserveOf(DEBT_SYM)]);
  const amt = Number(b.amount);
  if (!(amt > 0)) return { error: 'Enter an amount.' };
  const m = await market(), me = await signer(owner), ledger = await ledgerNow();
  const decimalsOf = (mint) => (mint === String(coll.getLiquidityMint()) ? coll.stats.decimals : debt.stats.decimals);
  const { quoter, swapper } = jupiterFor(owner, decimalsOf);
  const { boosts } = await positionsOf(owner);
  const had = boosts.find((x) => x.deposits.some((d) => d.sym === coin.sym));
  const obligation = had ? await m.getObligationByAddress(kit.address(had.address)) : null;
  // the budget goes in through the toolkit: its flash loan counts instructions
  const out = await sdk.getDepositWithLeverageIxs({
    owner: me, kaminoMarket: m, debtReserveAddress: debt.address, collReserveAddress: coll.address, depositAmount: new Decimal(String(b.amount)),
    priceDebtToColl: debt.getOracleMarketPrice().div(coll.getOracleMarketPrice()), slippagePct: new Decimal(BOOST_SLIPPAGE), obligation, referrer: kit.none(),
    currentLedgerInstant: ledger, targetLeverage: new Decimal(LEVERAGE), selectedTokenMint: coll.getLiquidityMint(), obligationTypeTagOverride: sdk.ObligationTypeTag.Leverage,
    scopeRefreshIx: [], budgetAndPriorityFeeIxs: await budgetIxs(1_000_000), quoteBufferBps: new Decimal(100), quoter, swapper, useV2Ixs: true,
  });
  const best = out[0];
  if (!best) return { error: 'Couldn’t find a route for that. Try a different amount.' };
  const c = best.initialInputs.calcs;
  const built = await finishV0(owner, best.ixs, best.lookupTables);
  const usdIn = amt * Number(coll.getOracleMarketPrice());
  return { ...built, plan: { put: amt, holds: Number(c.collTokenToDeposit), borrows: Number(c.debtTokenToBorrow) }, ...(usdIn >= PRIZE_MIN_USD ? { prize: 'boost' } : {}) };
}
async function buildUnboost(owner, b) {
  const { sdk, kit, Decimal, rpc } = await kamino();
  const coin = BOOST_COINS.find((c) => c.sym === b.coin);
  if (!coin) return { error: 'Pick a coin.' };
  const { boosts } = await positionsOf(owner);
  const had = boosts.find((x) => x.deposits.some((d) => d.sym === coin.sym));
  if (!had) return { error: 'No boost on that coin.' };
  const [coll, debt] = await Promise.all([reserveOf(coin.sym), reserveOf(DEBT_SYM)]);
  const m = await market(), me = await signer(owner), ledger = await ledgerNow();
  const obligation = await m.getObligationByAddress(kit.address(had.address));
  const decimalsOf = (mint) => (mint === String(coll.getLiquidityMint()) ? coll.stats.decimals : debt.stats.decimals);
  const { quoter, swapper } = jupiterFor(owner, decimalsOf);
  const deposited = new Decimal(had.deposits.find((d) => d.sym === coin.sym).amount);
  const borrowed = new Decimal((had.debt.find((d) => d.sym === DEBT_SYM) || { amount: 0 }).amount);
  const sol = Number((await rpc.getBalance(kit.address(owner)).send()).value);
  const out = await sdk.getWithdrawWithLeverageIxs({
    owner: me, kaminoMarket: m, debtReserveAddress: debt.address, collReserveAddress: coll.address, obligation, deposited, borrowed, referrer: kit.none(),
    currentLedgerInstant: ledger, withdrawAmount: deposited, priceCollToDebt: coll.getOracleMarketPrice().div(debt.getOracleMarketPrice()), slippagePct: new Decimal(BOOST_SLIPPAGE),
    isClosingPosition: true, selectedTokenMint: coll.getLiquidityMint(), budgetAndPriorityFeeIxs: await budgetIxs(1_000_000), scopeRefreshIx: [], quoteBufferBps: new Decimal(100),
    quoter, swapper, useV2Ixs: true, userSolBalanceLamports: sol,
  });
  if (!out[0]) return { error: 'Couldn’t find a route for that right now. Try again.' };
  return finishV0(owner, out[0].ixs, out[0].lookupTables);
}

// ---------------- prize tickets ----------------
// Staking, a real borrow and a boost earn bubbles and socks, paid by the laundry
// once the transaction is on chain. The ticket names the wallet, the setting and
// the transaction's blockhash, so it fits that one transaction only.
export const blockhashOf = (b64) => {
  const raw = Buffer.from(b64, 'base64');
  return (raw[1 + 64 * raw[0]] & 0x80) ? VersionedTransaction.deserialize(raw).message.recentBlockhash : Transaction.from(raw).recentBlockhash;
};
export const prizeTicket = (owner, op, b64) => {
  const payload = Buffer.from(JSON.stringify({ o: owner, op, bh: blockhashOf(b64), t: Date.now() })).toString('base64url');
  return payload + '.' + mac('dry:' + payload);
};
// Prizes only for something real: $10 or more borrowed or boosted (a stake is 1 SOL at least anyway).
const PRIZE_MIN_USD = 10;

// ---------------- sending ----------------
// A wallet that signs without sending hands the signed transaction back here.
// It must be paid for by the signed-in wallet; then it goes out once.
async function sendSigned(owner, b64) {
  let payer;
  try {
    const raw = Buffer.from(String(b64 || ''), 'base64');
    payer = (raw[1 + 64 * raw[0]] & 0x80) ? VersionedTransaction.deserialize(raw).message.staticAccountKeys[0].toBase58() : Transaction.from(raw).feePayer.toBase58();
  } catch { return { status: 400, body: { error: 'That isn’t a transaction.' } } }
  if (payer !== owner) return { status: 400, body: { error: 'That isn’t this wallet’s transaction.' } };
  try {
    const sig = await conn().sendRawTransaction(Buffer.from(b64, 'base64'), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    return { status: 200, body: { signature: sig } };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/already been processed/i.test(msg)) return { status: 200, body: { sent: true } };
    console.warn('dryer: send refused', msg.slice(0, 200));
    return { status: 409, body: { error: 'The network wouldn’t accept that. Nothing moved.' } };
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
        for (const c of [...new Set([...BORROW_COINS, ...BOOST_COINS].map((x) => x.sym))]) {
          const r = await reserveOf(c).catch((e) => { console.warn('dryer: Kamino unread', c, String((e && e.stack) || e).slice(0, 600)); return null; });
          if (r) coins[c] = { ...coinInfo(r), supplyApy: kr[c] ? kr[c].supplyApy : null };
        }
        return { on: true, stake: { apy: v ? v.apy : null, min: mins ? mins.min : LAMPORTS, rent: mins ? mins.rent : 2282880 },
          coins, usdcBorrowApy: kr[DEBT_SYM] ? kr[DEBT_SYM].borrowApy : null, leverage: LEVERAGE, borrowCoins: BORROW_COINS, boostCoins: BOOST_COINS };
      });
      return res.status(200).json(info);
    }

    // where a sent transaction is: confirmed, finalized, failed, or not seen yet
    if (q === 'status') {
      const sig = String(req.query.sig || '');
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return res.status(400).json({ error: 'Bad signature' });
      const { value } = await conn().getSignatureStatuses([sig], { searchTransactionHistory: false });
      const st = value && value[0];
      return res.status(200).json({ status: !st ? null : st.err ? 'failed' : st.confirmationStatus });
    }

    const owner = ownerFromSession(req);
    if (!owner) return res.status(401).json({ error: 'Connect your wallet first.' });

    if (q === 'mine') {
      const [stakes, pos, setup] = await Promise.all([stakesOf(owner).catch(() => null), positionsOf(owner).catch((e) => { console.warn('dryer: positions unread', String(e && e.message).slice(0, 160)); return null; }), hasSetup(owner).catch(() => null)]);
      return res.status(200).json({ stakes, borrow: pos ? pos.borrow : null, boosts: pos ? pos.boosts : null, unread: !pos, setup });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
    if (q === 'send') { const r = await sendSigned(owner, body.signed); return res.status(r.status).json(r.body); }
    if (q !== 'build') return res.status(404).json({ error: 'Unknown' });
    if (slowDown(owner)) return res.status(429).json({ error: 'Slow down a moment, then try again.' });

    const op = String(body.op || '');
    const built = op === 'stake' ? await buildStake(owner, body.sol)
      : op === 'unstake' || op === 'withdrawStake' ? await stakeMove(owner, body.stake, op === 'unstake' ? 'unstake' : 'withdraw')
      : op === 'setup' ? await buildSetup(owner)
      : op === 'borrow' ? await buildBorrow(owner, body)
      : op === 'repay' ? await buildRepay(owner, body)
      : op === 'boost' ? await buildBoost(owner, body)
      : op === 'unboost' ? await buildUnboost(owner, body)
      : { error: 'Unknown' };
    if (!built.tx) return res.status(built.needSetup ? 200 : 400).json(built);
    // never hand a player a transaction the network would refuse
    const t = await tryIt(built.tx);
    if (!t.ok) return res.status(409).json({ error: t.error });
    const { prize, ...rest } = built;
    return res.status(200).json({ ...rest, units: t.units, ...(prize ? { ticket: prizeTicket(owner, prize, built.tx) } : {}) });
  } catch (e) {
    console.error('dryer:', q, String((e && e.stack) || e).slice(0, 400));
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}
