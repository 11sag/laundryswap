// Xtreme (beta): a 2x long on BTC, SOL or ETH, opened for 1, 2 or 3 months and
// then closed by itself. The trade runs on Jupiter's perpetuals; the laundry
// takes no fee and gives no prize for it.
//
// Nothing here holds anyone's money. The player's own wallet signs the trade.
// For the close, the player signs it in advance: a transaction tied to a
// "durable nonce" (it never runs out the way a normal one does), which the
// server keeps and sends on the closing day. The only thing that transaction
// can do is close the player's own position and send what's left to the
// player's own wallet, in USDC. The nonce account belongs to the laundry's
// wallet, so the server (and only it) can also call a close off.

export const X_LEVERAGE = 2;
export const X_CYCLES = [1, 2, 3];                                   // months
export const PERPS = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu';
export const JLP_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// The markets: the coin's mint on Solana and its custody account in Jupiter's pool
// (for a long, the coin is its own collateral).
export const X_MARKETS = [
  { sym: 'BTC', mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', custody: '5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm' },
  { sym: 'SOL', mint: 'So11111111111111111111111111111111111111112', custody: '7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz' },
  { sym: 'ETH', mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', custody: 'AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn' },
];
// The smallest trade (Jupiter wants some size to open), and SOL kept back for
// the close later: the closing transaction pays a small fee and a refundable deposit.
export const X_MIN_SOL = 0.1;
export const X_KEEP_SOL = 0.02;
// Slippage allowed when opening, in basis points.
export const X_SLIPPAGE_BPS = 100;

// The closing day: the same day of the month, `months` later (UTC).
export function dueAt(fromMs, months) {
  const d = new Date(fromMs);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}
// Roughly where a 2x long gets wiped out: about half the entry price (Jupiter's
// own quote gives the exact one).
export const roughWipeout = (price) => price * (1 - 1 / X_LEVERAGE);
// A borrow rate per hour (percent) as a yearly one.
export const yearly = (hourlyPct) => (Number(hourlyPct) || 0) * 24 * 365;
