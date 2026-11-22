import { localFetch } from './local-http.mjs';

// The board has its own virtual origin: it must not share Pi Web's origin or
// gain access to the desktop backend. Only this fixed loopback service is used.
export const GOAL_ORIGIN = 'https://goal.piweb.invalid';
export function isGoalUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === GOAL_ORIGIN && !url.username && !url.password;
  } catch { return false; }
}

export async function goalFetch(request, { port = 30170 } = {}) {
  if (!isGoalUrl(request.url)) return new Response(null, { status: 403 });
  const method = request.method.toUpperCase(), route = new URL(request.url).pathname;
  if (!['GET', 'HEAD', 'POST'].includes(method)) return new Response(null, { status: 405 });
  // Electron's protocol handler can expose cross-origin responses, and omits
  // Origin on same-origin POSTs. Check the browser-supplied initiator for every
  // sensitive API, not just writes; health alone is public to the Pi overlay.
  const origin = request.headers.get('origin');
  if (route.startsWith('/api/') && route !== '/api/health' && (origin ? origin !== GOAL_ORIGIN : !isGoalUrl(request.referrer))) return new Response(null, { status: 403 });
  const extraHeaders = {};
  if (method === 'POST') {
    if (origin ? origin !== GOAL_ORIGIN : !isGoalUrl(request.referrer)) return new Response(null, { status: 403 });
    if (!(route === '/api/act' || /^\/api\/web\/[a-z.]{1,24}$/.test(route))) return new Response(null, { status: 405 });
    // The board still checks its own token, content type, rate limit and body.
    extraHeaders.origin = `http://127.0.0.1:${port}`;
  }
  try {
    return await localFetch(request, undefined, { hostname: '127.0.0.1', port }, { host: `127.0.0.1:${port}`, extraHeaders });
  } catch {
    return new Response('长目标看板服务暂时不可达', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
}
