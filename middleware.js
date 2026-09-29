// Laundry Swap lives at laundryswap.app and nowhere else. Its own domain opens
// on the laundry (a vercel.json rewrite cannot do it, because the site's own
// index.html is served before rewrites apply), and on every other host
// (Vercel's own addresses included) the laundry and its source do not exist.
export const config = { matcher: ['/', '/laundry', '/laundry.html', '/source', '/source/:path*'] };

export default function middleware(request) {
  const url = new URL(request.url);
  const host = (request.headers.get('host') || '').split(':')[0].toLowerCase();
  const front = url.pathname === '/';
  // www goes to the bare domain (vercel.json does this for every other path,
  // but these paths reach this middleware first); an invite link keeps its ?s=
  if (host === 'www.laundryswap.app') return Response.redirect('https://laundryswap.app' + url.pathname + url.search, 308);
  if (host === 'laundryswap.app') {
    if (!front) return new Response(null, { headers: { 'x-middleware-next': '1' } });
    return new Response(null, { headers: { 'x-middleware-rewrite': new URL('/laundry', request.url).toString() } });
  }
  if (!front) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
