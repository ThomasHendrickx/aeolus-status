import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import type { Context } from '../context.ts';
import { evaluate } from '../engine.ts';
import { inOrder } from '../order.ts';
import { closeSession, signInFresh } from '../session.ts';
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
const probeTile = '<div data-testid="harbour-tile">probe-ship</div>';
const shipPage = '<main><p data-testid="conversation-start">The start of your conversation with probe-ship</p></main>';
const worldAtStart = () => ({ mail: true, autoAppSignIn: false, appNoFleet: false, appEndsSession: false, consoleAllowed: true, chooseOrganisation: false, redeemLink: true, needsTerms: false, accountHome: '<main><h1>Home</h1><h2>Your account</h2></main>', consolePage: `<main>${tile}</main>`, bridgePage: '<main><h1>Bridge</h1></main>', homePage: '<main><h1>Home</h1></main>', fleetPage: `<main data-testid="fleet">${probeTile}</main>`, shipPage });
const world = worldAtStart();
let servers: Server[] = [];
let env: Record<string, string> = {};
const inbox: { id: string; text: string }[] = [];
let mailThrottled = 0;

before(async () => {
  const mail = await listen((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST' && mailThrottled > 0) {
      mailThrottled -= 1;
      response.writeHead(429).end();
    } else if (request.method === 'POST') {
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
  const fleet = await listen((_, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"shipId":"shp_probe","fleetId":"flt_probe","name":"probe-ship"}');
  });
  const app = await listen((request, response) => {
    const path = request.url?.split('?')[0];
    if (path === '/sign-in/start') {
      if (world.appNoFleet) {
        response.writeHead(302, { location: `${account.origin}/account`, ...(world.appEndsSession ? { 'set-cookie': 'signed-in=; Path=/; Max-Age=0' } : {}) }).end();
        return;
      }
      if (world.autoAppSignIn) { response.writeHead(302, { location: '/' }).end(); return; }
      html(response, '<button data-testid="sign-in-continue" onclick="location=\'/\'">Sign in</button>');
    } else if (path === '/fleet') {
      html(response, world.fleetPage);
    } else if (path === '/conversations/shp_probe') {
      html(response, world.shipPage);
    } else {
      html(response, world.homePage);
    }
  });
  const account = await listen((request, response) => {
    if (request.url === '/sign-in') {
      html(response, `<h1>Sign in</h1><label for="e">Email</label><input id="e"><button onclick="fetch('/ask').then(()=>{document.body.innerHTML='<h1>Check your mail</h1>'})">Email me a link</button>`);
    } else if (request.url === '/ask') {
      if (world.mail) {
        inbox.push({ id: '1', text: `Your link: ${account.origin}/link?token=a&amp;b=1 thanks` });
      }
      html(response, 'ok');
    } else if (request.url?.startsWith('/link')) {
      if (!world.redeemLink) {
        response.writeHead(302, { location: '/sign-in' }).end();
      } else if (world.chooseOrganisation) {
        html(response, `<main><h1>Choose your organisation</h1><ul><li><button onclick="location='/choose-other'">Other organisation</button></li><li><button onclick="location='/choose-probe'">Status probe</button></li></ul></main>`);
      } else {
        response.writeHead(302, { location: '/account', 'set-cookie': 'signed-in=yes; Path=/' }).end();
      }
    } else if (request.url === '/choose-probe') {
      response.writeHead(302, { location: '/account', 'set-cookie': 'signed-in=yes; Path=/' }).end();
    } else if (request.url === '/choose-other') {
      html(response, '<main><h1>Wrong organisation</h1></main>');
    } else if (request.url === '/welcome') {
      if (request.headers.cookie?.includes('signed-in=yes')) {
        html(response, '<main><h1>Welcome to Aeolus</h1><p>Signed in as probe@mail.test.</p><form action="/accept" method="post"><label><input type="checkbox" required> I accept the terms and privacy notice</label><button>Continue</button></form></main>');
      } else {
        response.writeHead(302, { location: '/sign-in' }).end();
      }
    } else if (request.url === '/accept' && request.method === 'POST') {
      world.needsTerms = false;
      response.writeHead(302, { location: '/account' }).end();
    } else if (request.url === '/account') {
      if (request.headers.cookie?.includes('signed-in=yes') && world.needsTerms) {
        response.writeHead(302, { location: '/welcome' }).end();
      } else if (request.headers.cookie?.includes('signed-in=yes')) {
        html(response, world.accountHome + `<section aria-labelledby="home-fleets"><h2 id="home-fleets">Your fleets</h2>${world.consoleAllowed ? `<button onclick="location='${consoleApp.origin}/'">Open console</button>` : ''}</section>`);
      } else {
        response.writeHead(302, { location: '/sign-in' }).end();
      }
    } else if (request.url === '/organisation/fleets') {
      html(response, `<button onclick="location='${consoleApp.origin}/'">Open in console</button>`);
    } else {
      html(response, 'no', 404);
    }
  });
  servers = [mail.server, gateway.server, consoleApp.server, app.server, account.server, fleet.server];
  env = { PROBE_MAIL_ADDRESS: PROBE, PROBE_MAIL_PASSWORD: 'p', MAIL_API: mail.origin, ACCOUNT_URL: account.origin, GATEWAY_URL: gateway.origin, APP_URL: app.origin, MAIL_WAIT_MS: '1500', FLEET_URL: fleet.origin, FLEET_PROBE_TOKEN: 'x' };
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
    if ((check as { session?: string }).session === 'uses') {
      await evaluate(accountSignIn, context, timing);
    }
    return await evaluate(check as never, context, timing);
  } finally {
    await closeSession(context);
  }
}
function reset(): void {
  Object.assign(world, worldAtStart());
  inbox.splice(0, inbox.length);
}

test('mail sign-in ends on the protected account home, not Bridge', { timeout: 30_000 }, async () => {
  reset();
  const context = fresh();
  try {
    assert.deepEqual(await evaluate({ ...accountSignIn, timeoutMs: 6_000 }, context, timing), { state: 'up', detail: 'a sign-in link mailed and followed to a signed-in page' });
  } finally {
    await closeSession(context);
  }
});

test('mail sign-in chooses the configured probe organisation before checking its home', { timeout: 30_000 }, async () => {
  reset();
  world.chooseOrganisation = true;
  const context = fresh({ PROBE_ORGANISATION: 'Status probe' });
  try {
    assert.deepEqual(await evaluate({ ...accountSignIn, timeoutMs: 6_000 }, context, timing), { state: 'up', detail: 'a sign-in link mailed and followed to a signed-in page' });
  } finally {
    await closeSession(context);
  }
});

test('mail sign-in succeeds at authenticated terms, with dependent pages not checked', { timeout: 30_000 }, async () => {
  reset();
  world.chooseOrganisation = true;
  world.needsTerms = true;
  const context = fresh({ PROBE_ORGANISATION: 'Status probe' });
  try {
    assert.deepEqual(await evaluate({ ...accountSignIn, timeoutMs: 2_000 }, context, timing), { state: 'up', detail: 'a sign-in link mailed and followed to a signed-in page' });
    assert.equal(world.needsTerms, true);
    for (const check of [consoleOverview, bridge, aeolusApp]) {
      const outcome = await evaluate(check, context, timing);
      assert.ok(outcome instanceof NotChecked);
      assert.equal(outcome.message, 'the probe must accept the account terms before these pages can be checked');
    }
  } finally {
    await closeSession(context);
  }
});

test('terms are accepted only when explicitly enabled', { timeout: 30_000 }, async () => {
  reset();
  world.chooseOrganisation = true;
  world.needsTerms = true;
  const context = fresh({ PROBE_ORGANISATION: 'Status probe', ACCEPT_PROBE_TERMS: 'true' });
  try {
    assert.deepEqual(await evaluate(accountSignIn, context, timing), { state: 'up', detail: 'a sign-in link mailed and followed to a signed-in page' });
    assert.equal(world.needsTerms, false);
    assert.deepEqual(await evaluate(bridge, context, timing), { state: 'up', detail: 'Bridge loads' });
  } finally {
    await closeSession(context);
  }
});

test('a configured organisation absent from the chooser fails explicitly', { timeout: 30_000 }, async () => {
  reset();
  world.chooseOrganisation = true;
  const context = fresh({ PROBE_ORGANISATION: 'Missing organisation' });
  try {
    assert.deepEqual(await evaluate({ ...accountSignIn, timeoutMs: 2_000 }, context, timing), { state: 'down', detail: 'the configured probe organisation was not offered' });
  } finally {
    await closeSession(context);
  }
});

test('an organisation chooser without probe configuration is not a product outage', { timeout: 30_000 }, async () => {
  reset();
  world.chooseOrganisation = true;
  const context = fresh();
  try {
    const outcome = await evaluate({ ...accountSignIn, timeoutMs: 2_000 }, context, timing);
    assert.ok(outcome instanceof NotChecked);
  } finally {
    await closeSession(context);
  }
});

test('a mailed link that leaves the probe signed out is still down', { timeout: 30_000 }, async () => {
  reset();
  world.redeemLink = false;
  const context = fresh();
  try {
    const outcome = await evaluate({ ...accountSignIn, timeoutMs: 2_000 }, context, timing);
    assert.ok('state' in outcome);
    assert.equal(outcome.state, 'down');
  } finally {
    await closeSession(context);
  }
});

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

test('a probe mailbox that answers 429 a few times is waited for, and the sign-in is up', { timeout: 120_000 }, async () => {
  reset();
  mailThrottled = 3;
  try {
    assert.deepEqual(await run(accountSignIn, fresh({ MAIL_BACKOFF_MS: '20' })), { state: 'up', detail: 'a sign-in link mailed and followed to a signed-in page' });
  } finally {
    mailThrottled = 0;
  }
});

test('a sign-in mail that never arrives is down for the sign-in, and the others are not checked', { timeout: 120_000 }, async () => {
  reset();
  world.mail = false;
  const context = fresh();
  try {
    assert.deepEqual(await evaluate(accountSignIn, context, timing), { state: 'down', detail: 'no sign-in mail arrived in time' });
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

test('an app whose fleet page shows other ships but not the probe own is down', { timeout: 120_000 }, async () => {
  reset();
  world.fleetPage = `<main data-testid="fleet">${tile}</main>`;
  assert.deepEqual(await run(aeolusApp), { state: 'down', detail: 'the page does not show the probe\'s own ship' });
});

test('an app whose ship page crashes is down while the home and fleet pages work', { timeout: 120_000 }, async () => {
  reset();
  world.shipPage = '<main><h1>This page did not open</h1><button data-testid="page-did-not-open-try-again">Try again</button></main>';
  assert.deepEqual(await run(aeolusApp), { state: 'down', detail: 'the page shows an error' });
  reset();
  world.shipPage = '<main><h1>Nothing here</h1></main>';
  assert.deepEqual(await run(aeolusApp), { state: 'down', detail: 'the ship page does not show the ship' });
});

test('the signed-in page checks keep the 30 second default and use the session the sign-in opened', () => {
  for (const check of [consoleOverview, bridge, aeolusApp]) {
    assert.equal(check.timeoutMs, undefined);
    assert.equal(check.session, 'uses');
  }
  assert.equal(accountSignIn.session, 'opens');
  assert.ok((accountSignIn.timeoutMs ?? Infinity) <= 200_000);
});

test('a page check without a sign-in before it is not checked, and does not sign in itself', async () => {
  reset();
  const context = fresh();
  try {
    assert.ok((await evaluate(bridge, context, timing)) instanceof NotChecked);
    assert.deepEqual(inbox, []);
  } finally {
    await closeSession(context);
  }
});

test('a sign-in whose mail never comes stops when its time is up, not when the mail wait ends', { timeout: 30_000 }, async () => {
  reset();
  world.mail = false;
  const context = fresh({ MAIL_WAIT_MS: '600000' });
  const controller = new AbortController();
  setTimeout(() => { controller.abort(); }, 1_500);
  const started = Date.now();
  try {
    await assert.rejects(signInFresh(context, controller.signal));
    assert.ok(Date.now() - started < 15_000);
  } finally {
    await closeSession(context);
  }
});

test('checks that use the session start after the ones that open it, the rest at once', async () => {
  const log: string[] = [];
  const check = (slug: string, session?: 'opens' | 'uses') => ({ slug, session }) as never;
  await inOrder([check('page-a', 'uses'), check('sign-in', 'opens'), check('plain')], async (item: { slug: string }) => {
    log.push(`start ${item.slug}`);
    await new Promise((done) => setTimeout(done, item.slug === 'sign-in' ? 50 : 1));
    log.push(`end ${item.slug}`);
  });
  assert.ok(log.indexOf('end sign-in') < log.indexOf('start page-a'));
  assert.ok(log.indexOf('start plain') < log.indexOf('end sign-in'));
});

test('without the probe mailbox nothing is checked', async () => {
  const outcome = await run(accountSignIn, fresh({ PROBE_MAIL_ADDRESS: '' }));
  assert.ok(outcome instanceof NotChecked);
});


test('a member without a console allowance is not checked, never down', { timeout: 15000 }, async () => {
  reset();
  world.consoleAllowed = false;
  const result = await run({ ...consoleOverview, timeoutMs: 6000 });
  assert.ok(result instanceof NotChecked);
  assert.equal(result.message, 'the probe account has no console allowance');
});

test('browser app sign-in can advance automatically without a continue button', { timeout: 15000 }, async () => {
  reset();
  world.autoAppSignIn = true;
  assert.deepEqual(await run({ ...aeolusApp, timeoutMs: 6000 }), { state: 'up', detail: 'the app loads' });
});


test('app returning to authenticated Account without an openable fleet is not checked', { timeout: 15000 }, async () => {
  reset();
  world.appNoFleet = true;
  const result = await run({ ...aeolusApp, timeoutMs: 6000 });
  assert.ok(result instanceof NotChecked);
  assert.equal(result.message, 'the probe account has no openable fleet');
});

test('app returning to Account after losing sign-in is still down', { timeout: 20000 }, async () => {
  reset();
  world.appNoFleet = true;
  world.appEndsSession = true;
  const result = await run({ ...aeolusApp, timeoutMs: 6000 });
  assert.ok(!(result instanceof NotChecked));
  assert.equal(result.state, 'down');
});
