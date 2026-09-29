// The house's Jupiter swap for one wash: SOL out of the house wallet, the picked
// token straight into the player's own token account.
//
// Kept apart from the handler so a test can build the exact transaction and
// simulate it against mainnet without a key and without moving anything.

const JUP = 'https://lite-api.jup.ag';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const ATA_RENT = 2039280;        // lamports to open a token account

async function jup(path, opts) {
  const r = await fetch(JUP + path, { ...(opts || {}), signal: AbortSignal.timeout(9000) });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.error) throw new Error((d && (d.error || d.message)) || ('Jupiter ' + r.status));
  return d;
}

// maxAccounts keeps the route small enough that the account-opening instruction
// still fits in one transaction (1,232 bytes); a Fartcoin route ran 1,130 without it.
export const quotePair = (inputMint, outputMint, amount, slippageBps = 100, maxAccounts = 48) =>
  jup(`/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true&maxAccounts=${maxAccounts}`);
// The live wash only ever spends SOL from the house.
export const quote = (mint, lamports, slippageBps = 100, maxAccounts = 48) => quotePair(SOL_MINT, mint, lamports, slippageBps, maxAccounts);

export const prices = (ids) => jup('/price/v3?ids=' + ids.join(','));

export const tokenInfo = (query) => jup('/tokens/v2/search?query=' + encodeURIComponent(query));

// The player's account for this token, under whichever token program owns the
// mint, and whether it exists yet.
export async function destination({ conn, web3, spl, owner, mint }) {
  const mintKey = new web3.PublicKey(mint);
  const info = await conn.getAccountInfo(mintKey);
  if (!info) throw new Error('No such token');
  const program = info.owner;
  const ata = spl.getAssociatedTokenAddressSync(mintKey, new web3.PublicKey(owner), false, program);
  const exists = Boolean(await conn.getAccountInfo(ata));
  return { ata, program, exists };
}

const toIx = (web3, i) => new web3.TransactionInstruction({
  programId: new web3.PublicKey(i.programId),
  keys: i.accounts.map((a) => ({ pubkey: new web3.PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(i.data, 'base64'),
});

// A transaction has to fit in 1,232 bytes. Some routes still come out too big at
// 48 accounts (Fartcoin did on 2026-09-27), so a route that does not fit is
// asked for again with fewer accounts before giving up.
const PACKET = 1232;
function fits(tx) { try { return tx.serialize().length <= PACKET; } catch { return false; } }
export async function buildSwap(args) {
  for (const maxAccounts of [48, 32, 24]) {
    const built = await buildOnce({ ...args, maxAccounts });
    if (fits(built.tx)) return built;
  }
  throw new Error('No route small enough for one transaction right now');
}

// An unsigned v0 transaction for the swap, plus what it was built from.
async function buildOnce({ conn, web3, spl, house, owner, mint, lamports, slippageBps = 100, maxAccounts = 48 }) {
  const q = await quote(mint, lamports, slippageBps, maxAccounts);
  const dest = await destination({ conn, web3, spl, owner, mint });
  const si = await jup('/swap/v1/swap-instructions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: q, userPublicKey: house.toBase58(), wrapAndUnwrapSol: true,
      destinationTokenAccount: dest.ata.toBase58(), dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200000, priorityLevel: 'high' } },
    }),
  });
  const instructions = [
    ...(si.computeBudgetInstructions || []).map((i) => toIx(web3, i)),
    // open the player's account for this token if they have never held it
    spl.createAssociatedTokenAccountIdempotentInstruction(house, dest.ata, new web3.PublicKey(owner), new web3.PublicKey(mint), dest.program),
    ...(si.setupInstructions || []).map((i) => toIx(web3, i)),
    toIx(web3, si.swapInstruction),
    ...(si.cleanupInstruction ? [toIx(web3, si.cleanupInstruction)] : []),
  ];
  const tables = (await Promise.all((si.addressLookupTableAddresses || [])
    .map((a) => conn.getAddressLookupTable(new web3.PublicKey(a))))).map((r) => r.value).filter(Boolean);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const message = new web3.TransactionMessage({ payerKey: house, recentBlockhash: blockhash, instructions }).compileToV0Message(tables);
  return { tx: new web3.VersionedTransaction(message), quote: q, dest, blockhash, lastValidBlockHeight };
}

// Sign and send. Returns the signature as soon as the network has it, and the
// confirmation as a separate promise, so the ledger can record the one before
// waiting on the other.
export async function sendSwap({ conn, built, signer }) {
  built.tx.sign([signer]);
  const signature = await conn.sendRawTransaction(built.tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmed = conn.confirmTransaction({ signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }, 'confirmed')
    .then((c) => { if (c.value && c.value.err) throw new Error('Swap failed on chain'); return true; });
  return { signature, confirmed };
}

// What actually landed in the player's account, from the transaction itself.
export async function received({ conn, signature, owner, mint }) {
  const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  const sum = (list) => (list || []).filter((b) => b.owner === owner && b.mint === mint)
    .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return (sum(tx && tx.meta && tx.meta.postTokenBalances) - sum(tx && tx.meta && tx.meta.preTokenBalances)).toString();
}

// ---------- the player's side of a live wash ----------
// One transaction for the player's own wallet to approve. SOL goes straight to
// the laundry. Any other token is swapped to SOL on Jupiter in the same
// transaction, and the least that swap can return (its slippage floor) is sent
// on to the laundry; anything above the floor stays with the player. A memo ties
// the payment to one wash, so a payment can never be counted twice or for
// another wash. The wallet shows the player exactly what it does before they
// approve, and nothing moves without that approval.
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

// Jupiter sizes the compute limit for its swap alone; the transfer and memo
// after it need a little more.
function roomFor(web3, ix, extra) {
  if (ix.programId.toBase58() !== COMPUTE_BUDGET || ix.data[0] !== 2) return ix;
  const data = Buffer.from(ix.data);
  data.writeUInt32LE(Math.min(1_400_000, data.readUInt32LE(1) + extra), 1);
  return new web3.TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
}

export async function buildPay({ conn, web3, owner, laundry, inMint, amount, memo, slippageBps = 50 }) {
  const payer = new web3.PublicKey(owner), to = new web3.PublicKey(laundry);
  const note = new web3.TransactionInstruction({ programId: new web3.PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(memo, 'utf8') });
  if (inMint === SOL_MINT) {
    const lamports = Number(amount);
    const instructions = [
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
      web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports }),
      note,
    ];
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const tx = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message());
    return { tx, lamports, lastValidBlockHeight };
  }
  for (const maxAccounts of [48, 32, 24]) {
    const q = await quotePair(inMint, SOL_MINT, amount, slippageBps, maxAccounts);
    const lamports = Number(q.otherAmountThreshold);
    const si = await jup('/swap/v1/swap-instructions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200000, priorityLevel: 'high' } },
      }),
    });
    const instructions = [
      ...(si.computeBudgetInstructions || []).map((i) => roomFor(web3, toIx(web3, i), 30_000)),
      ...(si.setupInstructions || []).map((i) => toIx(web3, i)),
      toIx(web3, si.swapInstruction),
      ...(si.cleanupInstruction ? [toIx(web3, si.cleanupInstruction)] : []),
      web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports }),
      note,
    ];
    const tables = (await Promise.all((si.addressLookupTableAddresses || [])
      .map((a) => conn.getAddressLookupTable(new web3.PublicKey(a))))).map((r) => r.value).filter(Boolean);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const tx = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(tables));
    if (fits(tx)) return { tx, lamports, quote: q, lastValidBlockHeight };
  }
  throw new Error('No route small enough for one transaction right now');
}

// A plain SOL payment out of the laundry: the payout when the player washes into
// SOL, and the refund when a wash cannot start after they paid.
export async function buildSend({ conn, web3, from, to, lamports, memo }) {
  const instructions = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
    web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: new web3.PublicKey(to), lamports }),
    ...(memo ? [new web3.TransactionInstruction({ programId: new web3.PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(memo, 'utf8') })] : []),
  ];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions }).compileToV0Message());
  return { tx, blockhash, lastValidBlockHeight };
}

// ---------- sending an NFT out of the vending machine ----------
// g00bs are programmable NFTs: their token accounts are frozen and only the
// Token Metadata program can move them, following the collection's rule set.
// So the send is Token Metadata's Transfer instruction (V1), built here by hand
// with every account it needs. A plain NFT (no rule set) takes the same path;
// the program handles both. The destination's token account is opened in the
// same instruction, paid by the vending wallet.
const TM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const AUTH_RULES = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg';
const SYSVAR_IX = 'Sysvar1nstructions1111111111111111111111111';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

// The parts of a Metadata account the send needs: the token standard and the
// rule set. Read field by field from the account's Borsh layout.
export function readMetadata(data) {
  const b = Buffer.from(data); let o = 1 + 32 + 32;               // key, update authority, mint
  const str = () => { const n = b.readUInt32LE(o); const s = b.subarray(o + 4, o + 4 + n).toString('utf8').replace(/\0+$/, '').trim(); o += 4 + n; return s; };
  const name = str(); str(); const uri = str(); o += 2;            // name, symbol, uri, seller fee
  if (b[o++] === 1) { const n = b.readUInt32LE(o); o += 4 + n * 34; } // creators
  o += 2;                                                           // primary sale, mutable
  if (b[o++] === 1) o += 1;                                         // edition nonce
  let tokenStandard = null; if (b[o++] === 1) tokenStandard = b[o++];
  let collection = null, verified = false;
  if (b[o++] === 1) { verified = b[o++] === 1; collection = b.subarray(o, o + 32); o += 32; }
  if (b[o++] === 1) o += 17;                                        // uses
  if (b[o++] === 1) { const v = b[o++]; o += v === 0 ? 8 : 8; }    // collection details
  let ruleSet = null;
  if (o < b.length && b[o++] === 1) { o += 1; if (b[o++] === 1) ruleSet = b.subarray(o, o + 32); }
  return { name, uri, tokenStandard, collection, verified, ruleSet };
}

export async function buildNftSend({ conn, web3, spl, from, to, mint }) {
  const P = (s) => new web3.PublicKey(s);
  const tm = P(TM), mintKey = P(mint), owner = P(to);
  const pda = (...seeds) => web3.PublicKey.findProgramAddressSync(seeds, tm)[0];
  const metadata = pda(Buffer.from('metadata'), tm.toBuffer(), mintKey.toBuffer());
  const edition = pda(Buffer.from('metadata'), tm.toBuffer(), mintKey.toBuffer(), Buffer.from('edition'));
  const source = spl.getAssociatedTokenAddressSync(mintKey, from, true);
  const dest = spl.getAssociatedTokenAddressSync(mintKey, owner, true);
  const record = (ta) => pda(Buffer.from('metadata'), tm.toBuffer(), mintKey.toBuffer(), Buffer.from('token_record'), ta.toBuffer());
  const info = await conn.getAccountInfo(metadata);
  if (!info) throw new Error('No metadata for that NFT');
  const meta = readMetadata(info.data);
  const programmable = meta.tokenStandard === 4 || meta.tokenStandard === 5;
  const none = tm;                                                  // an optional account left out is passed as the program id
  const keys = [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: from, isSigner: false, isWritable: false },
    { pubkey: dest, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mintKey, isSigner: false, isWritable: false },
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: edition, isSigner: false, isWritable: false },
    { pubkey: programmable ? record(source) : none, isSigner: false, isWritable: programmable },
    { pubkey: programmable ? record(dest) : none, isSigner: false, isWritable: programmable },
    { pubkey: from, isSigner: true, isWritable: false },
    { pubkey: from, isSigner: true, isWritable: true },
    { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: P(SYSVAR_IX), isSigner: false, isWritable: false },
    { pubkey: P(SPL_TOKEN), isSigner: false, isWritable: false },
    { pubkey: P(SPL_ATA), isSigner: false, isWritable: false },
    { pubkey: meta.ruleSet ? P(AUTH_RULES) : none, isSigner: false, isWritable: false },
    { pubkey: meta.ruleSet ? new web3.PublicKey(meta.ruleSet) : none, isSigner: false, isWritable: false },
  ];
  // Transfer (49), V1 (0), amount 1, no authorization data
  const data = Buffer.alloc(11); data[0] = 49; data[1] = 0; data.writeBigUInt64LE(1n, 2); data[10] = 0;
  const instructions = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    new web3.TransactionInstruction({ programId: tm, keys, data }),
  ];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions }).compileToV0Message());
  return { tx, blockhash, lastValidBlockHeight, programmable, ruleSet: meta.ruleSet ? new web3.PublicKey(meta.ruleSet).toBase58() : null };
}
