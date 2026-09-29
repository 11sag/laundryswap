// Simulates the player's payment transaction on mainnet (nothing signed or sent)
// and checks the laundry would receive exactly what the wash counts on.
import * as web3 from '@solana/web3.js';
import { buildPay, SOL_MINT } from './laundry-swap.js';
const conn = new web3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const LAUNDRY = '7xtQiKG7DoSm7nxFyckdSX5LpEPopRk2KeJ6ohwgJNff';
const cases = [
  ['SOL from the house', '2GAFN7bnYTQrQqoypSb2FXMcMYFdTKRvu3VTSvYZJ6UF', SOL_MINT, String(0.05e9)],
  ['USDC from the treasury', 'C8Nj4SHwPKRf8SRxffeePvkk8QqhvfrQgFZqSaAbescq', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', String(12e6)],
  ['PIPPIN from the house', '2GAFN7bnYTQrQqoypSb2FXMcMYFdTKRvu3VTSvYZJ6UF', 'Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump', String(200e6)],
];
const before = await conn.getBalance(new web3.PublicKey(LAUNDRY));
for (const [name, owner, inMint, amount] of cases) {
  try {
    const p = await buildPay({ conn, web3, owner, laundry: LAUNDRY, inMint, amount, memo: 'laundry:test-' + Date.now() });
    const sim = await conn.simulateTransaction(p.tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [LAUNDRY] } });
    const after = sim.value.accounts && sim.value.accounts[0] ? sim.value.accounts[0].lamports : null;
    const memoSeen = (sim.value.logs || []).some((l) => l.includes('laundry:test-'));
    console.log(name.padEnd(24), sim.value.err ? 'FAIL ' + JSON.stringify(sim.value.err) + ' ' + (sim.value.logs || []).slice(-2).join(' | ').slice(0, 200)
      : `ok  ${p.tx.serialize().length} bytes, laundry +${after - before} lamports (agreed ${p.lamports}), memo ${memoSeen ? 'seen' : 'MISSING'}, ${sim.value.unitsConsumed} CU`);
  } catch (e) { console.log(name.padEnd(24), 'ERROR', String(e.message || e).slice(0, 200)); }
  await new Promise((r) => setTimeout(r, 1500));
}
