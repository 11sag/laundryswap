// Xtreme (beta) checks that need no network: its rules (xtreme-core.js), the
// accounts and the close request the server builds (api/xtreme.js).
// Run: node --import ./tools-dev-register.mjs tools-xtreme-test.mjs
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, Transaction, VersionedTransaction, TransactionMessage, SystemProgram } from '@solana/web3.js';
import { X_LEVERAGE, X_CYCLES, X_MARKETS, PERPS, dueAt, roughWipeout, yearly } from './xtreme-core.js';

process.env.AUTH_SECRET = 'test-secret';
const { positionPda, closeRequestIx, closeTx, checkInstant } = await import('./api/xtreme.js');
let n = 0;
const ok = (c, what) => { assert.ok(c, what); n++; };

// ---- the rules ----
ok(X_LEVERAGE === 2 && X_CYCLES.join() === '1,2,3', '2x, for 1, 2 or 3 months');
ok(X_MARKETS.map((m) => m.sym).join() === 'BTC,SOL,ETH', 'BTC, SOL and ETH');
ok(dueAt(Date.UTC(2026, 9, 12, 15), 1) === Date.UTC(2026, 10, 12, 15), 'Oct 12 plus a month is Nov 12');
ok(dueAt(Date.UTC(2026, 0, 31), 1) === Date.UTC(2026, 1, 28), 'Jan 31 plus a month stops at the end of February');
ok(dueAt(Date.UTC(2026, 10, 30), 3) === Date.UTC(2027, 1, 28), 'into the next year');
ok(roughWipeout(80000) === 40000, 'a 2x long is wiped out near half its price');
ok(Math.abs(yearly(0.0013) - 11.388) < 1e-9, 'an hourly borrow rate as a yearly one');

// ---- accounts ----
// Jupiter's own answer for this wallet's BTC long (perps API, 2026-10-12)
ok(positionPda('FcSZqtqGAJQ7SfSeqYvFofPD8jNMupkZ8viXuiceAna5', X_MARKETS[0].custody) === '86NzGrwgyu5rjtxhUDaRE9B7AW23LFuVXXtEGuYdnDC6', 'the BTC long account matches Jupiter’s');
ok(positionPda('316USxRZV6C1LtDmT3DrTBF7UavYwWrtDP2zhsSAb9M6', X_MARKETS[1].custody) === '9PRpMzdoLgVTLchztYyEsmU5j91rJXTTsmycaHc5jWR4', 'a SOL long account matches one open on chain');

// ---- the close request ----
const owner = Keypair.generate(), houseKp = Keypair.generate();
const ix = closeRequestIx(owner.publicKey.toBase58(), X_MARKETS[0].custody, 12345n);
const disc = crypto.createHash('sha256').update('global:create_decrease_position_market_request').digest().subarray(0, 8);
ok(ix.programId.toBase58() === PERPS && ix.keys.length === 16, 'Jupiter’s program, 16 accounts');
ok(Buffer.from(ix.data).subarray(0, 8).equals(disc), 'the create decrease request discriminator');
ok(ix.data.length === 8 + 24 + 1 + 2 + 8, 'fields: three zero amounts, no swap floor, entire position, counter');
ok(ix.data.readBigUInt64LE(24) === 0n, 'a long’s lowest price bound is 0: it closes at whatever the price is');
ok(ix.data[32] === 0 && ix.data[33] === 1 && ix.data[34] === 1, 'no swap floor; the whole position');
ok(ix.keys[0].pubkey.equals(owner.publicKey) && ix.keys[0].isSigner && ix.keys[5].isWritable, 'the owner signs; the request account is written');
ok(ix.keys[4].pubkey.toBase58() === positionPda(owner.publicKey.toBase58(), X_MARKETS[0].custody), 'it closes this owner’s own position');

// ---- the closing transaction, tied to a nonce ----
const nonceKey = Keypair.generate().publicKey.toBase58(), nonceValue = Keypair.generate().publicKey.toBase58();
const built = closeTx(owner.publicKey.toBase58(), X_MARKETS[0].custody, nonceKey, nonceValue, houseKp.publicKey.toBase58());
const tx = Transaction.from(Buffer.from(built.b64, 'base64'));
ok(tx.recentBlockhash === nonceValue, 'its blockhash is the nonce (it never runs out)');
ok(tx.instructions[0].programId.equals(SystemProgram.programId) && tx.instructions[0].data.readUInt32LE(0) === 4, 'the first instruction advances the nonce');
ok(tx.feePayer.equals(owner.publicKey), 'the owner pays its fee');
ok(tx.instructions.at(-1).programId.toBase58() === PERPS, 'the last is the close request');
ok(tx.signatures.length === 2 && tx.signatures.some((s) => s.publicKey.equals(houseKp.publicKey)), 'the laundry signs only as the nonce’s owner');
// the owner signs; the laundry adds its signature on the day, and the owner's still holds
tx.partialSign(owner);
const kept = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
ok(crypto.createHash('sha256').update(kept.serializeMessage()).digest('hex') === built.hash, 'the message is the one made (its hash is kept)');
kept.partialSign(houseKp);
ok(kept.verifySignatures(), 'both signatures hold on the day');

// ---- Jupiter's own transactions ----
const payer = Keypair.generate();
const v0 = (keyProgram) => Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: nonceValue, instructions: [{ programId: new PublicKey(keyProgram), keys: [], data: Buffer.alloc(0) }] }).compileToV0Message()).serialize()).toString('base64');
ok(checkInstant(v0(PERPS), payer.publicKey.toBase58()) === null, 'a trade paid by this wallet, Jupiter’s program only: fine');
ok(checkInstant(v0(PERPS), Keypair.generate().publicKey.toBase58()) !== null, 'paid by another wallet: refused');
ok(checkInstant(v0('DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e'), payer.publicKey.toBase58()) === null && checkInstant(v0('Ed25519SigVerify111111111111111111111111111'), payer.publicKey.toBase58()) === null, 'Jupiter’s price update (SOL trades) is fine');
ok(checkInstant(v0(Keypair.generate().publicKey.toBase58()), payer.publicKey.toBase58()) !== null, 'another program: refused');

console.log(`xtreme: ${n} checks passed`);
process.exit(0);
