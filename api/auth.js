// Wallet sign-in. The user proves they hold the key for an address by signing a
// nonce; nothing is ever transferred and no key ever reaches this server.
//
// Stateless on purpose: the nonce and the session are both HMAC-signed blobs, so
// there is no store to keep in sync and no lambda-to-lambda memory to get stale.

import crypto from 'crypto';

const SECRET = process.env.AUTH_SECRET || '';
const NONCE_TTL   = 5 * 60 * 1000;          // long enough to approve in a wallet
const SESSION_TTL = 30 * 24 * 3600 * 1000;  // a month, then sign in again

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  const bytes = [0];
  for (const ch of str) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const isAddress = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && b58decode(a)?.length === 32;

// The message opens with the site that asked for it, so the wallet shows where
// the request came from: a name for a site that has one, its address otherwise.
const SITES = { 'laundryswap.app': 'Laundry Swap' };
const siteName = (req) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].toLowerCase()
    .replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '').slice(0, 64);
  return SITES[host] || host || 'Wallet sign-in';
};
function signInMessage(owner, nonce, issued, site) {
  // Shown verbatim in the wallet, so it has to read like a sentence, not a hash.
  return [
    site,
    '',
    'Sign in to prove this wallet is yours.',
    'This does not move funds and costs nothing.',
    '',
    'Wallet: ' + owner,
    'Nonce: ' + nonce,
    'Issued: ' + issued,
  ].join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!SECRET) return res.status(503).json({ error: 'Sign-in is not configured' });

  const q = String(req.query.q || '');
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  try {
    // ---- hand out something to sign ----
    if (q === 'nonce') {
      const owner = String(req.query.owner || '').trim();
      if (!isAddress(owner)) return res.status(400).json({ error: 'Not a Solana address' });
      const ts = Date.now();
      const nonce = ts + '.' + mac('n:' + owner + ':' + ts);
      const issued = new Date(ts).toISOString();
      return res.status(200).json({ nonce, issued, message: signInMessage(owner, nonce, issued, siteName(req)) });
    }

    // ---- check the signature actually came from that key ----
    if (q === 'verify' && req.method === 'POST') {
      const owner = String(body.owner || '').trim();
      const nonce = String(body.nonce || '');
      const issued = String(body.issued || '');
      const sig = String(body.signature || '');
      if (!isAddress(owner)) return res.status(400).json({ error: 'Not a Solana address' });

      const [tsRaw, tag] = nonce.split('.');
      const ts = Number(tsRaw);
      if (!ts || !tag || !safeEq(tag, mac('n:' + owner + ':' + ts))) {
        return res.status(400).json({ error: 'That nonce was not issued here' });
      }
      if (Date.now() - ts > NONCE_TTL) return res.status(400).json({ error: 'Took too long, try again' });

      const pub = b58decode(owner);
      const sigBytes = b58decode(sig);
      if (!pub || !sigBytes || sigBytes.length !== 64) return res.status(400).json({ error: 'Bad signature' });

      // raw ed25519 key -> SPKI so node's verifier will take it
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]);
      const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
      const msg = Buffer.from(signInMessage(owner, nonce, issued, siteName(req)), 'utf8');
      if (!crypto.verify(null, msg, key, sigBytes)) {
        return res.status(401).json({ error: 'Signature does not match that wallet' });
      }

      const exp = Date.now() + SESSION_TTL;
      const payload = Buffer.from(JSON.stringify({ owner, exp })).toString('base64url');
      return res.status(200).json({ session: payload + '.' + mac('s:' + payload), owner, exp });
    }

    // ---- who is this session ----
    if (q === 'me') {
      // the header only: a session in the address would end up in logs and history
      const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const [payload, tag] = t.split('.');
      if (!payload || !tag || !safeEq(tag, mac('s:' + payload))) {
        return res.status(401).json({ error: 'Not signed in' });
      }
      const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (!d.exp || d.exp < Date.now()) return res.status(401).json({ error: 'Session expired' });
      return res.status(200).json({ owner: d.owner, exp: d.exp });
    }

    return res.status(404).json({ error: 'No such route' });
  } catch (e) {
    console.error('auth', e);
    return res.status(500).json({ error: 'Sign-in failed' });
  }
}
