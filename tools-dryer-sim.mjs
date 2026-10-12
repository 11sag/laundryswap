// Tries every dryer setting against mainnet as real wallets, without signing:
// each build is simulated by the server itself (signatures not checked), so
// nothing moves. Run: node tools-dryer-sim.mjs [op] [owner] [args as json]
import crypto from 'node:crypto';
process.env.AUTH_SECRET = 'sim-secret';
process.env.SOLANA_NETWORK = 'mainnet';
const { default: handler } = await import('./api/dryer.js');
const token = (owner) => { const p = Buffer.from(JSON.stringify({ owner, exp: Date.now() + 3600e3 })).toString('base64url'); return p + '.' + crypto.createHmac('sha256', 'sim-secret').update('s:' + p).digest('base64url'); };
const call = (q, owner, body, method = body ? 'POST' : 'GET') => new Promise((done) => {
  const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(j) { done({ code: this.code, j }); } };
  handler({ method, query: { q }, headers: owner ? { authorization: 'Bearer ' + token(owner) } : {}, body: body || {} }, res);
});
const show = (label, r) => console.log(label, r.code, JSON.stringify(r.j, (k, v) => (k === 'tx' ? (v ? `<${Buffer.from(v, 'base64').length} bytes>` : v) : v)).slice(0, 700));
const [op, owner, args] = process.argv.slice(2);
if (op === 'info') show('info', await call('info'));
else if (op === 'mine') show('mine', await call('mine', owner));
else show(op, await call('build', owner, { op, ...(args ? JSON.parse(args) : {}) }));
process.exit(0);
