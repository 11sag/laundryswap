// Simulates a $2 bubble prize for every gift coin on mainnet: the real Jupiter
// route, a brand-new winner (so their token account gets opened), the house
// wallet standing in as payer. Nothing is signed or sent.
import * as web3 from '@solana/web3.js';
import * as spl from '@solana/spl-token';
import { buildSwap, prices, SOL_MINT } from './laundry-swap.js';
import { GIFTS } from './laundry-core.js';
const conn = new web3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const payer = new web3.PublicKey('2GAFN7bnYTQrQqoypSb2FXMcMYFdTKRvu3VTSvYZJ6UF');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = await conn.getBalance(payer);
const sol = Number((await prices([SOL_MINT]))[SOL_MINT].usdPrice);
const lamports = Math.round(2 / sol * 1e9);
console.log(`payer has ${(bal / 1e9).toFixed(4)} SOL, SOL $${sol.toFixed(2)}, $2 = ${lamports} lamports`);
let ok = 0;
for (const g of (process.argv[2] ? GIFTS.filter((x) => x.key === process.argv[2]) : GIFTS)) {
  const winner = web3.Keypair.generate().publicKey.toBase58();
  let line = g.symbol.padEnd(9);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const built = await buildSwap({ conn, web3, spl, house: payer, owner: winner, mint: g.mint, lamports });
      const size = built.tx.serialize().length;
      const sim = await conn.simulateTransaction(built.tx, { sigVerify: false, replaceRecentBlockhash: true });
      const err = sim.value.err;
      const out = Number(built.quote.outAmount);
      line += err ? `FAIL ${JSON.stringify(err)} ${(sim.value.logs || []).slice(-2).join(' | ').slice(0, 160)}` : `ok  ${size} bytes, ${sim.value.unitsConsumed} CU, new account ${built.dest.exists ? 'no' : 'yes'}, quote out ${out}`;
      if (!err) ok++;
      break;
    } catch (e) {
      if (attempt === 2) line += 'ERROR ' + String(e.message || e).slice(0, 140);
      else await sleep(2500);
    }
  }
  console.log(line);
  await sleep(1200);
}
console.log(`${ok}/${GIFTS.length} simulated cleanly`);
