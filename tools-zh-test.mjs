// CN mode's words (laundry-zh.js): sample text in, Chinese out, the same way the
// page swaps it (an exact match, then a pattern), and what must stay as is.
// Run: node tools-zh-test.mjs
import assert from 'node:assert/strict';
import { EXACT, PATTERNS } from './laundry-zh.js';

function tr(t) {
  const s = String(t).trim();
  if (!s || !/[A-Za-z]/.test(s)) return t;
  let out = Object.prototype.hasOwnProperty.call(EXACT, s) ? EXACT[s] : null;
  if (out == null) for (const [re, to] of PATTERNS) { const m = s.match(re); if (m) { out = typeof to === 'function' ? to(m, tr) : s.replace(re, to); break; } }
  if (out == null) return t;
  return String(t).match(/^\s*/)[0] + out + String(t).match(/\s*$/)[0];
}
let n = 0;
const is = (en, zh) => { assert.equal(tr(en), zh, en); n++; };
const same = (en) => { assert.equal(tr(en), en, 'should stay: ' + en); n++; };

is('Swap fee range', '兑换费用区间');
is('5.1% APY', '年化 5.1%');
is('6.2% A YEAR', '年利率 6.2%');
is('FOR 2 MONTHS', '2 个月');
is('1 month', '1 个月');
is('STAKE 1.5 SOL', '质押 1.5 SOL');
is('0 SOL in your wallet', '钱包里有 0 SOL');
is('Up to $47.28', '最多 $47.28');
is('Fee 0.25%: 0.025 SOL.', '手续费 0.25%：0.025 SOL。');
is('Fee 0.25%: about 0.01181 SOL ($1.25).', '手续费 0.25%：约 0.01181 SOL（$1.25）。');
is('Put in: 1 SOL, 0.5 ETH', '已存入：1 SOL, 0.5 ETH');
is('Owes $300.00. Part is sold if it falls below $95.00.', '欠款 $300.00。跌破 $95.00 会卖出一部分。');
is('Owes $12.00.', '欠款 $12.00。');
is('2x SOL: $11.70 now', '2 倍 SOL：现值 $11.70');
is('Down $0.20. Wiped out below $54.48. Closes by itself on 12月12日.', '亏损 $0.20。跌破 $54.48 会爆仓。将在 12月12日 自动平仓。');
is('Up $3.10. Wiped out below $41,983.00. Auto close is off.', '盈利 $3.10。跌破 $41,983.00 会爆仓。自动平仓未开启。');
is('Approve it in your wallet. Fee: 0.005 SOL.', '请在钱包里确认。手续费：0.005 SOL。');
is('The trade is open, but auto close is off. Busy. Try again.', '交易已开仓，但自动平仓没有开启。忙碌中。请再试一次。');
is('That didn’t go through. Nothing moved.', '没有成功，资金没有变动。');
is('No fees on swaps until Friday. Covers swaps up to 1 SOL, 3 left today.', '星期五 之前兑换免手续费。每次最多 1 SOL，今天还剩 3 次。');
is('200 bubbles + 2 socks', '200 个泡泡 + 2 只袜子');
is('For staking your SOL. 2 more prizes today.', '奖励你质押 SOL。今天还有 2 次奖品。');
is('5m ago', '5 分钟前');
is('least, 61.527 Fartcoin', '最少，61.527 Fartcoin');
is('takes 1% to 7.3%', '少给 1% 到 7.3%');
is('−7.7% to +7.4%', '−7.7% 到 +7.4%');
is('Approve it in your wallet. It sends 0.1 SOL to the laundry, 7xtQ…JNff. Your Fartcoin comes back in a second transaction.', '请在钱包里确认。它会把 0.1 SOL 发到洗衣店（7xtQ…JNff）。你的 Fartcoin 会在第二笔交易里回来。');
is('  Swap  ', '  兑换  ');
is('BETA. NFA / DYOR.', '测试版。非投资建议 / 请自行研究。');
// what stays as it is: names, numbers, symbols, links
same('1 SOL = 663.797 Fartcoin');
same('Fartcoin');
same('$10.84');
same('Laundry Swap');
same('C0de');
same('GitHub');
// no Latin letters left in a whole-sentence translation (coin names aside)
for (const [en, zh] of Object.entries(EXACT)) {
  const left = zh.replace(/\b(SOL|USDC|BTC|ETH|cbBTC|JitoSOL|JupSOL|mSOL|BNB|NFT|g00b|Solana|Solscan|Tensor|Laundry Swap|Relay|Phantom|Solflare|Backpack|MetaMask|Coinbase|Wallet|Ethereum|Base|Robinhood|CN|GitHub|C0de)\b/g, '');
  assert.ok(!/[A-Za-z]{3,}/.test(left), 'English left in: ' + en + ' -> ' + zh);
  n++;
}
console.log(`zh: ${n} checks passed`);
