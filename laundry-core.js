// The laundry's wash cycles and the draw that picks one, shared by the server
// and the page. This file is served as-is at /laundry-core.js, and the server
// imports this exact file, so the code anyone can read is the code that runs.

import crypto from 'crypto';
//
// A wash comes out Shrunk (it takes a little) 6 times in 10, or Sparkling (it
// adds a little) 4 times in 10. How much is random too, inside the swap fee
// range the page shows: between 1% and the range's take side, or between 1% and
// its add side. The page lists all this behind See the odds, and the server
// draws from exactly this code, so the odds a player reads are the odds they get.
export const CYCLES = [
  { key: 'shrunk',    name: 'Shrunk',    chance: 60 },
  { key: 'sparkling', name: 'Sparkling', chance: 40 },
];

// The swap fee range. The cent button rolls a new one: the add side lands
// between 6% and 9%, and the take side is always a little bigger, by 0.2 to 1
// point, so it tops out at 10%. No range favours the player, no matter how many
// times it is rolled: the best one a player can pick still returns 99.2%.
export const RANGE = { lose: 60, floor: 0.01, min: 0.06, max: 0.09, gapMin: 0.002, gapMax: 0.01 };
const r4 = (x) => Math.round(x * 1e4) / 1e4;
export function rollRange(u, v) {
  const hi = r4(RANGE.min + u * (RANGE.max - RANGE.min));
  return { lo: r4(hi + RANGE.gapMin + v * (RANGE.gapMax - RANGE.gapMin)), hi };
}
// Whether a range is one the machine could have rolled (the server checks every
// range a page sends).
export const validRange = (r) => Boolean(r) && Number.isFinite(r.lo) && Number.isFinite(r.hi)
  && r.hi >= RANGE.min && r.hi <= RANGE.max && r4(r.lo - r.hi) >= RANGE.gapMin && r4(r.lo - r.hi) <= RANGE.gapMax
  && r4(r.lo) === r.lo && r4(r.hi) === r.hi;
// Average return under a range: about 0.990 across all rolls, never above 0.9924.
export const averageFor = (r) => 1 - (RANGE.lose / 100) * (RANGE.floor + r.lo) / 2 + (1 - RANGE.lose / 100) * (RANGE.floor + r.hi) / 2;
// Two uniform draws in [0,1) to a wash: the first picks the side, the second
// how far into it.
export function washOut(r, u, v) {
  const x = (typeof u === 'number' && u >= 0 && u < 1 ? u : 0), y = (typeof v === 'number' && v >= 0 && v < 1 ? v : 0);
  if (x * 100 < RANGE.lose) return { ...CYCLES[0], mult: r4(1 - (RANGE.floor + y * (r.lo - RANGE.floor))) };
  return { ...CYCLES[1], mult: r4(1 + (RANGE.floor + y * (r.hi - RANGE.floor))) };
}

// The draw: HMAC-SHA256 keyed with the server's seed, over "clientSeed:nonce:index".
// The top 52 bits of the digest become a number in [0,1). The seed's SHA-256 hash
// is shown before the wash and the seed itself after, so anyone can redo this.
export function draw(serverSeed, clientSeed, nonce, index) {
  const h = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${index}`).digest();
  return Number(h.readBigUInt64BE(0) >> 12n) / 2 ** 52;
}
export const seedHash = (seed) => crypto.createHash('sha256').update(seed).digest('hex');

// One wash: what a given seed, client seed and nonce land on under a range.
export const washCycle = (serverSeed, clientSeed, nonce, range) =>
  washOut(range, draw(serverSeed, clientSeed, nonce, 0), draw(serverSeed, clientSeed, nonce, 1));

// ---------- lucky bubbles ----------
// A lucky bubble gives away a coin from the drum. The server buys it fresh on
// Jupiter with SOL from the giveaway wallet and sends it straight to the
// winner's Solana wallet. What a prize is worth, in dollars: most are $2, a few
// are more than $3, and none is more than $10. The chances add up to 100.
export const GIFT_BANDS = [
  { from: 1.00, to: 1.99,  chance: 25 },
  { from: 2.00, to: 2.00,  chance: 55 },
  { from: 2.01, to: 3.00,  chance: 14 },
  { from: 3.01, to: 5.00,  chance: 4.5 },
  { from: 5.01, to: 10.00, chance: 1.5 },
];

// Two uniform draws in [0,1): the first picks the band, the second the amount
// inside it. Returns whole cents.
export function giftCents(u, v) {
  let x = (u >= 0 && u < 1 ? u : 0) * 100;
  for (const b of GIFT_BANDS) {
    if (x < b.chance) {
      const lo = Math.round(b.from * 100), hi = Math.round(b.to * 100);
      return lo + Math.min(hi - lo, Math.floor((v >= 0 && v < 1 ? v : 0) * (hi - lo + 1)));
    }
    x -= b.chance;
  }
  return Math.round(GIFT_BANDS[0].from * 100);
}

// The coins a bubble can give: the ones in the drum that have a verified Solana
// mint with real liquidity on Jupiter. Each is equally likely.
export const GIFTS = [
  { key: 'pengu',    symbol: 'PENGU',    mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv' },
  { key: 'trump',    symbol: 'TRUMP',    mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN' },
  { key: 'bonk',     symbol: 'BONK',     mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { key: 'useless',  symbol: 'USELESS',  mint: 'Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk' },
  { key: 'wif',      symbol: 'WIF',      mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { key: 'fartcoin', symbol: 'FARTCOIN', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' },
  { key: 'melania',  symbol: 'MELANIA',  mint: 'FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P' },
  { key: 'bome',     symbol: 'BOME',     mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82' },
  { key: 'ban',      symbol: 'BAN',      mint: '9PR7nCP9DpcUotnDPVLUBUZKu5WAYkwrCUx9wDnSpump' },
  { key: 'popcat',   symbol: 'POPCAT',   mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { key: 'pnut',     symbol: 'PNUT',     mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump' },
  { key: 'moodeng',  symbol: 'MOODENG',  mint: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY' },
  { key: 'troll',    symbol: 'TROLL',    mint: '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2' },
  { key: 'mew',      symbol: 'MEW',      mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5' },
  { key: 'zerebro',  symbol: 'ZEREBRO',  mint: '8x5VqbHA8D7NkD52uNuS5nnt3PwA8pLD34ymskeSo2Wn' },
  { key: 'griffain', symbol: 'GRIFFAIN', mint: 'KENJSUYLASHUMfHyy5o4Hp2FdNqZg1AsUPhfH2kYvEP' },
  { key: 'giga',     symbol: 'GIGA',     mint: '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9' },
  { key: 'goat',     symbol: 'GOAT',     mint: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump' },
  { key: 'pippin',   symbol: 'PIPPIN',   mint: 'Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump' },
  { key: 'ponke',    symbol: 'PONKE',    mint: '5z3EqYQo9HiCEs3R84RCDMu2n7anpDMxRhdK8PSWmrRC' },
  { key: 'spx6900',  symbol: 'SPX6900',  mint: 'J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr' },
  { key: 'ansem',    symbol: 'ANSEM',    mint: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump' },
  { key: 'pump',     symbol: 'PUMP',     mint: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn' },
  { key: 'pyth',     symbol: 'PYTH',     mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  { key: 'hnt',      symbol: 'HNT',      mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux' },
];

// ---------- the vending machine ----------
// Bubbles buy pulls. The machine has 20 slots, 4 across and 5 down: four hold
// g00b NFTs and the rest candy bars. A pull wins an NFT 1 time in 50, but only
// while the machine has an NFT to give; every other pull drops a candy bar,
// which is just for fun and worth nothing. The draw uses the same committed
// seed as a wash, so a pull can be checked the same way.
export const VEND = { price: 100, nftChance: 0.02, cols: 4, rows: 5, nftSlots: [1, 6, 12, 19] };
// The only NFTs the machine gives: ones in these verified collections. Anything
// else that lands in the vending wallet (spam airdrops, say) is never sent on.
export const VEND_COLLECTIONS = [
  { name: 'g00bs', key: 'CLJGJXF6mgFdRvguc9jkReRYtbbgvigKAWnfm7smacDm', market: 'https://www.tensor.trade/trade/g00bs' },
];
const CANDY_SLOTS = Array.from({ length: VEND.cols * VEND.rows }, (_, i) => i).filter((i) => !VEND.nftSlots.includes(i));
// Two uniform draws in [0,1): the first decides NFT or candy bar, the second
// which slot it drops from.
export function vendPull(u, v, canWin) {
  const nft = Boolean(canWin) && u < VEND.nftChance;
  const pool = nft ? VEND.nftSlots : CANDY_SLOTS;
  return { kind: nft ? 'nft' : 'candy', slot: pool[Math.min(pool.length - 1, Math.floor(v * pool.length))] };
}
export const vendDraw = (serverSeed, clientSeed, nonce, canWin) =>
  vendPull(draw(serverSeed, clientSeed, nonce, 0), draw(serverSeed, clientSeed, nonce, 1), canWin);
