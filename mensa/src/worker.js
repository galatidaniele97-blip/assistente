// Entry point Cloudflare Workers: API + file statici + pulizia programmata.

import { handleApi, purgeExpired } from './api.js';
import { d1 } from './db-d1.js';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; " +
    "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export default {
  async fetch(request, env, ctx) {
    if (!env.SESSION_SECRET) {
      return new Response('SESSION_SECRET non configurato (wrangler secret put SESSION_SECRET).', { status: 500 });
    }
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const response = await handleApi(request, env, d1(env.DB));
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  },

  async scheduled(event, env, ctx) {
    const weeks = Number(env.RETENTION_WEEKS ?? 12);
    const result = await purgeExpired(d1(env.DB), weeks);
    console.log(`Retention: ordini eliminati ${result.orders} (precedenti a ${result.cutoff}).`);
  },
};
