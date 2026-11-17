import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import type { Context } from '../context.ts';
import { evaluate } from '../engine.ts';
import { closeSession } from '../session.ts';
import { NotChecked } from '../types.ts';
import { accountSignIn, aeolusApp, bridge, consoleOverview } from './signed-in.ts';

const timing = { timeoutMs: 60_000, retryDelayMs: 0, sleep: () => Promise.resolve() };
const PROBE = 'probe@mail.test';

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}
const html = (response: ServerResponse, body: string, status = 200): void => {
  response.writeHead(status, { 'content-type': 'text/html' });
  response.end(body);
};

const tile = '<div data-testid="harbour-tile">a ship</div>';
const world = { mail: true, consolePage: `<main>${tile}</main>`, bridgePage: '<main><h1>Bridge</h1></main>', homePage: '<main><h1>Home</h1></main>', fleetPage: `<main data-testid="fleet">${tile}</main>` };
let servers: Server[] = [];
let env: Record<string, string> = {};
const inbox: { id: string; text: string }[] = [];

before(async () => {
  const mail = await listen((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') {
      response.end('{"token":"t"}');
    } else if (request.method === 'DELETE') {
      inbox.splice(0, inbox.length);
      response.writeHead(204).end();
    } else if (request.url === '/messages') {
      response.end(JSON.stringify({ 'hydra:member': inbox.map(({ id }) => ({ id })) }));
    } else {
      response.end(JSON.stringify({ text: inbox[0]?.text }));
    }
  });
  const gateway = await listen((_, response) => html(response, world.bridgePage));
  const consoleApp = await listen((_, response) => html(response, world.consolePage));
  const app = await listen((request, response) => {
    if (request.url === '/sign-in/start') {
      html(response, '<button data-testid="sign-in-continue" onclick="location=\'/\'">Sign in</button>');
    } else {
      html(response, request.url === '/fleet' ? world.fleetPage : world.homePage);
    }
  });
  const account = await listen((request, response) => {
    if (request.url === '/sign-in') {
      html(response, `<h1>Sign in</h1><label for="e">Email</label><input id="e"><button onclick="fetch('/ask').then(()=>{document.body.innerHTML='<h1>Check your mail</h1>'})">Continue</button>`);
    } else if (request.url === '/ask') {
      if (world.mail) {
        inbox.push({ id: '1', text: `Your link: ${account.origin}/link?token=a&amp;b=1 thanks` });
      }
      html(response, 'ok');
    } else if (request.url?.startsWith('/link')) {
      response.writeHead(302, { location: `${gateway.origin}/bridge` }).end();
    } else if (request.url === '/organisation/fleets') {
      html(response, `<button onclick="location='${consoleApp.origin}/'">Open in console</button>`);
    } else {
      html(response, 'no', 404);
    }
  });
  servers = [mail.server, gateway.server, consoleApp.server, app.server, account.server];
  env = { PROBE_MAIL_ADDRESS: PROBE, PROBE_MAIL_PASSWORD: 'p', MAIL_API: mail.origin, ACCOUNT_URL: account.origin, GATEWAY_URL: gateway.origin, APP_URL: app.origin, MAIL_WAIT_MS: '1500' };
});
after(() => {
  for (const server of servers) {
    server.close();
  }
});

function fresh(over: Record<string, string> = {}): Context {
  return { env: { ...env, ...over }, fetch, now: () => Date.now() };
}
async function run(check: Parameters<typeof evaluate>[0], context = fresh()): Promise<unknown> {
  try {
    return await evaluate(check as never, context, timing);
  } finally {
    await closeSession(context);
  }
}
function reset(): void {
  Object.assign(world, { mail: true, consolePage: `<main>${tile}</main>`, bridgePage: '<main><h1>Bridge</h1></main>', homePage: '<main><h1>Home</h1></main>', fleetPage: `<main data-testid="fleet">${tile}</main>` });
  inbox.splice(0, inbox.length);
}

test('with everything healthy the sign-in, console, Bridge and app are up', { timeout: 120_000 }, async () => {
  reset();
  const context = fresh();
  try {
    assert.deepEqual(await evaluate(accountSignIn, context, timing), { state: 'up', detail: 'a sign-in link mailed and followed to a signed-in page' });
    assert.deepEqual(await evaluate(consoleOverview, context, timing), { state: 'up', detail: 'the console loads' });
    assert.deepEqual(await evaluate(bridge, context, timing), { state: 'up', detail: 'Bridge loads' });
    assert.deepEqual(await evaluate(aeolusApp, context, timing), { state: 'up', detail: 'the app loads' });
  } finally {
    await closeSession(context);
  }
});

test('a sign-in mail that never arrives is down for the sign-in, and the others are not checked', { timeout: 120_000 }, async () => {
  reset();
  world.mail = false;
  const context = fresh();
  try {
    assert.deepEqual(await evaluate(accountSignIn, context, timing), { state: 'down', detail: 'no sign-in mail arrived within 5 minutes' });
    assert.ok((await evaluate(consoleOverview, context, timing)) instanceof NotChecked);
  } finally {
    await closeSession(context);
  }
});

test('the app crashing into its error boundary is down', { timeout: 120_000 }, async () => {
  reset();
  world.homePage = '<main><h1>This page did not open</h1><button data-testid="page-did-not-open-try-again">Try again</button></main>';
  assert.deepEqual(await run(aeolusApp), { state: 'down', detail: 'the page shows an error' });
});

test('a script error on a page is down, with a count', { timeout: 120_000 }, async () => {
  reset();
  world.bridgePage = '<main><h1>Bridge</h1><script>throw new Error("boom")</script></main>';
  assert.deepEqual(await run(bridge), { state: 'down', detail: 'the page raised 1 script error' });
});

test('a console that shows no ship is down; so is a fleet page with none', { timeout: 120_000 }, async () => {
  reset();
  world.consolePage = '<main><h1>Your fleet</h1></main>';
  assert.deepEqual(await run(consoleOverview), { state: 'down', detail: 'the page shows no ship' });
  reset();
  world.fleetPage = '<main data-testid="fleet"></main>';
  assert.deepEqual(await run(aeolusApp), { state: 'down', detail: 'the page shows no ship' });
});

test('without the probe mailbox nothing is checked', async () => {
  const outcome = await run(accountSignIn, fresh({ PROBE_MAIL_ADDRESS: '' }));
  assert.ok(outcome instanceof NotChecked);
});
