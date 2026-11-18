import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import type { Context } from '../context.ts';
import { evaluate } from '../engine.ts';
import { accountPage, gatewayHttp, siteCom, siteDev } from './public-pages.ts';

const timing = { timeoutMs: 20_000, retryDelayMs: 0, sleep: () => Promise.resolve() };

async function serve(routes: Record<string, { status?: number; type?: string; body?: string; delayMs?: number }>): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    const route = routes[request.url ?? ''] ?? { status: 404, body: 'no' };
    setTimeout(() => {
      response.writeHead(route.status ?? 200, { 'content-type': route.type ?? 'text/html' });
      response.end(route.body ?? '');
    }, route.delayMs ?? 0);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, server };
}

const page = (head = ''): string => `<!doctype html><head><link rel="icon" href="/icon.png">${head}</head><main><h1>Aeolus</h1></main>`;
const env = (name: string, origin: string): Context => ({ env: { [name]: origin }, fetch, now: () => Date.now() });

test('a page that loads with its icon is up', async () => {
  const { origin, server } = await serve({ '/': { body: page() }, '/sign-in': { body: page() }, '/icon.png': { type: 'image/png', body: 'x' } });
  try {
    assert.deepEqual(await evaluate(siteDev, env('SITE_URL', `${origin}/`), timing), { state: 'up', detail: 'the site loads' });
    assert.deepEqual(await evaluate(accountPage, env('ACCOUNT_URL', origin), timing), { state: 'up', detail: 'the sign-in page loads' });
    assert.equal((await evaluate(siteCom, env('SITE_COM_URL', `${origin}/`), timing) as { state: string }).state, 'up');
  } finally {
    server.close();
  }
});

test('failed assets include origin, path and status without query secrets', async () => {
  const { origin, server } = await serve({ '/': { body: page('<script src="/app.js?token=private-secret"></script>') } });
  try {
    const outcome = await evaluate(siteDev, env('SITE_URL', `${origin}/`), timing);
    assert.deepEqual(outcome, { state: 'down', detail: `2 assets of the page failed to load: ${origin}/app.js (HTTP 404), ${origin}/icon.png (HTTP 404)` });
    assert.doesNotMatch(JSON.stringify(outcome), /private-secret|token=/);
  } finally {
    server.close();
  }
});

test('failed background fetch and an aborted stream do not make the page down', async () => {
  const background = `<script>
    fetch('/analytics');
    const controller = new AbortController();
    fetch('/stream', { signal: controller.signal }).catch(() => {});
    setTimeout(() => controller.abort(), 100);
  </script>`;
  const { origin, server } = await serve({ '/': { body: page(background) }, '/icon.png': { type: 'image/png', body: 'x' }, '/analytics': { status: 401 }, '/stream': { delayMs: 1000 } });
  try {
    assert.deepEqual(await evaluate(siteDev, env('SITE_URL', `${origin}/`), timing), { state: 'up', detail: 'the site loads' });
  } finally {
    server.close();
  }
});

test('a working account root with a broken /sign-in is down', async () => {
  const { origin, server } = await serve({ '/': { body: page() }, '/sign-in': { status: 500, body: page() }, '/icon.png': { type: 'image/png', body: 'x' } });
  try {
    assert.equal((await evaluate(accountPage, env('ACCOUNT_URL', origin), timing) as { state: string }).state, 'down');
  } finally {
    server.close();
  }
});

test('a page that answers 500 is down', async () => {
  const { origin, server } = await serve({ '/': { status: 500, body: page() } });
  try {
    assert.equal((await evaluate(siteDev, env('SITE_URL', `${origin}/`), timing) as { state: string }).state, 'down');
  } finally {
    server.close();
  }
});

test('a page that loads in over 5 s is degraded', { timeout: 30_000 }, async () => {
  const { origin, server } = await serve({ '/': { body: page(), delayMs: 5_300 }, '/icon.png': { type: 'image/png', body: 'x' } });
  try {
    const outcome = await evaluate(siteDev, env('SITE_URL', `${origin}/`), timing) as { state: string; detail: string };
    assert.equal(outcome.state, 'degraded');
    assert.match(outcome.detail, /^the site took 5\.\d s to load$/);
  } finally {
    server.close();
  }
});

const GATEWAY = 'https://gateway.test';
function gateway(over: { discovery?: Response; mcp?: Response }): Context {
  return {
    env: { GATEWAY_URL: GATEWAY },
    now: () => Date.now(),
    fetch: ((url: string) => Promise.resolve(String(url).endsWith('/mcp')
      ? over.mcp ?? new Response('{"error":"unauthorized"}', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="x"' } })
      : over.discovery ?? Response.json({ issuer: GATEWAY }))) as typeof fetch,
  };
}

test('the gateway: valid discovery and a 401 with its challenge is up', async () => {
  assert.equal((await evaluate(gatewayHttp, gateway({}), timing) as { state: string }).state, 'up');
});

test('the gateway: a discovery error, a wrong issuer or an /mcp that does not challenge is down', async () => {
  const cases: [Parameters<typeof gateway>[0], string][] = [
    [{ discovery: new Response('', { status: 502 }) }, 'the OAuth discovery document answered 502'],
    [{ discovery: Response.json({ issuer: 'https://other.test' }) }, 'the OAuth discovery document has no valid issuer'],
    [{ discovery: new Response('<html>', { status: 200 }) }, 'the OAuth discovery document has no valid issuer'],
    [{ mcp: new Response('{}', { status: 200 }) }, 'the MCP endpoint answered 200 to an unauthenticated call, not 401 with its challenge'],
    [{ mcp: new Response('', { status: 401 }) }, 'the MCP endpoint answered 401 to an unauthenticated call, not 401 with its challenge'],
  ];
  for (const [over, detail] of cases) {
    assert.deepEqual(await evaluate(gatewayHttp, gateway(over), timing), { state: 'down', detail });
  }
});
