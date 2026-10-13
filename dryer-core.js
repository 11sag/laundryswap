// The dryer: what each dial setting does, and the limits the server keeps.
// The server imports this exact file, and the page reads the same numbers, so
// what a player is told is what the server allows.
//
//   STAKE   SOL staked with a top rated validator, in a stake account only the
//           player's wallet controls. The network's minimum is 1 SOL. Unstaking
//           frees it at the end of the current epoch (up to about 2 days); the
//           page says 14 days to be safe.
//   BORROW  A coin put into Kamino (the biggest lending market on Solana) and
//           USDC borrowed against it. Kamino sells part of the coin if its price
//           falls far enough; the page shows how far that is.
//   BOOST   1.5x on a coin: Kamino lends USDC, Jupiter swaps it for more of the
//           coin, all in one transaction. Gains and losses are both 1.5x.
//
// Nothing here holds anyone's money. Every transaction is the player's own,
// approved in their own wallet, and the laundry never signs it.

export const KAMINO_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export const DIAL = [
  { key: 'stake', label: 'STAKE' },
  { key: 'borrow', label: 'BORROW' },
  { key: 'boost', label: 'BOOST' },
];

// Coins Kamino lends against, by the symbol its market uses, with the name the
// page shows. Memecoins can't be borrowed against on Kamino, so they're not here.
export const BORROW_COINS = [
  { sym: 'SOL', name: 'SOL' },
  { sym: 'JITOSOL', name: 'JitoSOL' },
  { sym: 'JupSOL', name: 'JupSOL' },
  { sym: 'MSOL', name: 'mSOL' },
  { sym: 'cbBTC', name: 'Bitcoin (cbBTC)' },
  { sym: 'ETH', name: 'ETH' },
];
export const BOOST_COINS = [
  { sym: 'SOL', name: 'SOL' },
  { sym: 'cbBTC', name: 'Bitcoin (cbBTC)' },
];
export const DEBT_SYM = 'USDC';

// Borrowing stops well short of where Kamino would sell: at most this share of
// the most Kamino would lend, so a normal dip doesn't put the coin at risk.
export const BORROW_CAP = 0.6;
// The boost is fixed at 1.5x.
export const LEVERAGE = 1.5;
// Slippage allowed on the boost's swap, percent.
export const BOOST_SLIPPAGE = 0.5;
// SOL kept back for fees when a player stakes or puts in "everything".
export const KEEP_SOL = 0.01;

// The price at which Kamino starts selling: debt / (coin amount x liquidation LTV).
export function liqPrice(coinAmount, debtUsd, liqLtv) {
  if (!(coinAmount > 0) || !(liqLtv > 0)) return null;
  return debtUsd / (coinAmount * liqLtv);
}
// How much of the way to that point a position is, 0 (no debt) to 1 (selling).
export function riskOf(collUsd, debtUsd, liqLtv) {
  if (!(debtUsd > 0)) return 0;
  if (!(collUsd > 0) || !(liqLtv > 0)) return 1;
  return Math.min(1, debtUsd / (collUsd * liqLtv));
}
// The most a player may borrow against `collUsd` of a coin, with what they owe already.
export function borrowRoom(collUsd, maxLtv, debtUsd) {
  return Math.max(0, collUsd * maxLtv * BORROW_CAP - (debtUsd || 0));
}
