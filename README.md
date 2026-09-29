# Laundry Swap

The code behind [laundryswap.app](https://laundryswap.app): a Solana swap with a wash cycle. You swap one token for another, and the washer either takes a little or adds a little. It is published so anyone can read it and check that it does what it says. The same files are on the site at [laundryswap.app/source](https://laundryswap.app/source).

## What your wallet is asked to sign

- **Signing in** signs a plain sentence that names the site. It moves no money and costs nothing. Wallets refuse to use a signed message as a transaction.
- **A swap on Solana** is one transaction your wallet shows you before you approve it. It sends the amount you typed to the laundry wallet, with a memo naming that wash. If you pay with a token other than SOL, the same transaction swaps it to SOL on Jupiter first and sends on the least that swap can return; anything above that stays with you.
- **Paying from Ethereum, Base, Robinhood Chain or BNB Chain** goes through [Relay](https://relay.link). Your wallet sends the amount to Relay's contract on that chain, and Relay delivers SOL to the laundry wallet on Solana. A token that is not the chain's own coin first needs an approval for exactly that amount, to Relay's router and nobody else. The server checks every transaction Relay hands back before the page asks you to sign it.
- The site never asks for your secret phrase and cannot move anything your wallet did not approve.

## How a live swap works

1. **Commit.** The server picks a secret seed for your next wash and shows you only its SHA-256 hash.
2. **Pay.** Your wallet approves the payment described above.
3. **Wash.** The server reads your payment back from the chain and checks who paid, how much, and which wash it was for. A payment must carry exactly one laundry memo and can pay for one wash only. The server draws the cycle from the committed seed and pays you from the laundry wallet in the token you picked. The seed is revealed with the result.

Every payout and refund is signed and written down before it is sent, and a send that errors is settled from the chain rather than sent again, so a busy network can slow a payout but never pay it twice. If a payout cannot go out, your payment is sent back.

Every step is on chain. The site's Recent panel links each wash's payment and payout on Solscan.

## The odds

All of this is in [`laundry-core.js`](laundry-core.js), the same file the server imports.

- 6 washes in 10 come out **Shrunk** and 4 in 10 come out **Sparkling**.
- How much is random too, inside the **swap fee range** the page shows: the add side is between 6% and 9%, and the take side is always a little bigger, by 0.2 to 1 point, up to 10%. A Shrunk wash takes between 1% and the take side; a Sparkling wash adds between 1% and the add side.
- The cent button rolls a new range. No range favours the player however often it is rolled: the average return is about 99.0%, and the best range anyone can get returns 99.24%.

## Checking a wash yourself

A finished wash gives you its seed, the hash shown before you paid, your client seed, the nonce and the range. Then:

```js
import { seedHash, washCycle } from './laundry-core.js';
seedHash(seed) === hash;                              // the seed is the one promised
washCycle(seed, clientSeed, nonce, range).mult;       // the multiplier you got
```

## Bubbles, invites and the vending machine

- **Bubbles.** Every wallet starts with 200. Popping them earns bubble rewards, counted only for connected wallets at a person's pace.
- **Lucky bubbles.** Now and then a bubble pays $1 to $10 in a coin from the drum, bought on Jupiter and sent to your wallet. At most one a day per wallet, two per connection, and $25 a day across everyone.
- **Invites.** A friend who joins with your link gets 300 bubbles and so do you, and their first swap gets you 500 more. Every 3 friends who swap give you 7 days of no fees: washes up to 0.1 SOL, 5 a day, go through as plain swaps, with nothing taken and nothing added.
- **The vending machine.** A pull costs 100 bubbles. While the machine holds an NFT, 1 pull in 50 gives one, at most one a day per wallet and five a day across everyone. Every other pull drops a candy bar, which is just for fun and worth nothing. A pull is drawn from a committed seed the same way a wash is.

## Where the money is

| Wallet | Address | Job |
| --- | --- | --- |
| Laundry | [`7xtQiKG7DoSm7nxFyckdSX5LpEPopRk2KeJ6ohwgJNff`](https://solscan.io/account/7xtQiKG7DoSm7nxFyckdSX5LpEPopRk2KeJ6ohwgJNff) | Takes swap payments and pays swaps out |
| Bubble prizes | [`5CoB5P8Uau6oAS16qMt6naJfZKH5hQzNKWFDZH11Aq4W`](https://solscan.io/account/5CoB5P8Uau6oAS16qMt6naJfZKH5hQzNKWFDZH11Aq4W) | Pays the occasional lucky bubble |
| Vending machine | [`CJbcCYgSWshiawR7ARjfeqci7ydfNUvSB2aPhUtKQobG`](https://solscan.io/account/CJbcCYgSWshiawR7ARjfeqci7ydfNUvSB2aPhUtKQobG) | Holds the NFTs the machine gives |

The keys live on the server, which is what lets the laundry pay out without waiting on anyone. That means the laundry's own balances are what is at risk if the server were ever broken into, never a player's wallet. We keep those balances small.

## Limits

- A swap on Solana is worth between 0.05 and 0.5 SOL. The top end shrinks if the laundry wallet is low, so the machine only offers washes it can pay.
- A wallet can have 3 unpaid swaps waiting at once.

## Files

| File | What it does |
| --- | --- |
| `laundry.html` | The page |
| `laundry-core.js` | The odds, the range rules, the draw, lucky bubble prizes and the vending machine |
| `laundry-swap.js` | Builds the Solana transactions: your payment, the payout, refunds and NFT sends |
| `laundry-wallet.js`, `wallet.js` | Wallet sign in and transaction approval in the browser |
| `api/laundry.js` | The server: quotes, commit, pay, wash, refunds, other chains, bubbles, invites, the vending machine, recent washes |
| `api/auth.js` | Checks the signed sign in message and issues a session |
| `middleware.js`, `vercel.json` | Routing on Vercel |

## Tests

```sh
npm install
npm test
```

The tests run the real server code against an in-memory ledger, a stand-in for the Solana calls that would move money, and a stand-in for Relay, with real Jupiter routes. Nothing real is sent. `tools-pay-sim.mjs` and `tools-gift-sim.mjs` simulate real transactions on mainnet, again without sending anything.

## Reporting a problem

See [SECURITY.md](SECURITY.md).
