import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Context } from '../context.ts';
import type { ListedShip } from '../fleet.ts';
import { evaluate, publicDetail } from '../engine.ts';
import { NotChecked, Unconfigured } from '../types.ts';
import { fleetList, fleetRoundTrip } from './fleet-core.ts';
import { squadrons, trierarchs, watch } from './fleet-ships.ts';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const timing = { timeoutMs: 1_000, retryDelayMs: 0, sleep: () => Promise.resolve() };

function ship(over: Partial<ListedShip> & { type: string; kind: string }): ListedShip {
  return { id: `shp_${over.type}`, name: over.type, status: 'crewed', lastSeenAt: ago(1), ...over };
}
const healthy = (): ListedShip[] => [
  ship({ type: 'trierarch', kind: 'trierarch' }),
  ship({ type: 'trierarch', kind: 'trierarch', name: 'b' }),
  ship({ type: 'trierarch-plugin', kind: 'plugin' }),
  ship({ type: 'squadrons', kind: 'plugin' }),
  ship({ type: 'watch', kind: 'plugin' }),
];

/** A fleet that answers by path; `clock` advances `slow` ms per request. */
function context(answers: Record<string, (body: Record<string, unknown>) => unknown>, options: { token?: string; slow?: number } = {}): Context & { seen: string[] } {
  let now = NOW;
  const seen: string[] = [];
  return {
    seen,
    env: { FLEET_PROBE_TOKEN: 'token' in options ? options.token : 'secret' },
    now: () => now,
    fetch: ((url: string, init?: RequestInit) => {
      const path = String(url).replace('https://fleet.aeolus-fleet.dev/api/v1', ''); // privacy-guard: allow ssh-alias
      seen.push(`${init?.method ?? 'GET'} ${path} ${init?.headers ? (init.headers as Record<string, string>).authorization : ''}`);
      now += options.slow ?? 0;
      const answer = answers[path];
      if (!answer) {
        return Promise.resolve(new Response('', { status: 404 }));
      }
      const result = answer(init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {});
      return Promise.resolve(result instanceof Response ? result : Response.json(result));
    }) as typeof fetch,
  };
}
const listing = (ships: ListedShip[]) => ({ '/fleet/list': () => ({ items: ships, nextCursor: null }) });

test('a check without the probe token is not checked', async () => {
  const ctx = context(listing(healthy()), { token: undefined });
  for (const check of [fleetList, fleetRoundTrip, trierarchs, squadrons, watch]) {
    assert.ok((await evaluate(check, ctx, timing)) instanceof Unconfigured);
  }
  assert.deepEqual(ctx.seen, []);
});

test('the fleet list: up with a trierarch ship, read with the probe token', async () => {
  const ctx = context(listing(healthy()));
  assert.equal((await evaluate(fleetList, ctx, timing) as { state: string }).state, 'up');
  assert.deepEqual(ctx.seen, ['POST /fleet/list Bearer secret']);
});

test('the fleet list: a 500 is down, as in the rollback that broke every trierarch list', async () => {
  const ctx = context({ '/fleet/list': () => new Response('boom', { status: 500 }) });
  assert.deepEqual(await evaluate(fleetList, ctx, timing), { state: 'down', detail: 'the fleet answered 500 to /fleet/list' });
  assert.equal(ctx.seen.length, 2);
});

test('the fleet list: no trierarch ship is down, and over 2 s is degraded', async () => {
  const none = context(listing(healthy().filter((s) => s.kind !== 'trierarch')));
  assert.deepEqual(await evaluate(fleetList, none, timing), { state: 'down', detail: 'the fleet list holds no trierarch ship' });
  const slow = context(listing(healthy()), { slow: 2_500 });
  assert.deepEqual(await evaluate(fleetList, slow, timing), { state: 'degraded', detail: 'the fleet list took 2.5 s' });
});

test('the fleet list: reads every page', async () => {
  const pages = [{ items: [ship({ type: 'squadrons', kind: 'plugin' })], nextCursor: 'two' }, { items: [ship({ type: 'trierarch', kind: 'trierarch' })], nextCursor: null }];
  let page = 0;
  const ctx = context({ '/fleet/list': () => pages[page++] });
  assert.equal((await evaluate(fleetList, ctx, timing) as { state: string }).state, 'up');
});

function roundTrip(options: { deliver: boolean; slow?: number }): Context & { seen: string[] } {
  let nonce = '';
  return context({
    '/ship/whoami': () => ({ shipId: 'shp_probe' }),
    '/ship/send': (body) => {
      nonce = String(body.payload);
      assert.deepEqual(body.selector, { kind: 'ship', shipId: 'shp_probe' });
      return { messageId: 'msg_1' };
    },
    '/ship/receive': () => ({ deliveries: options.deliver ? [{ deliveryId: 'dlv_1', payload: nonce }] : [] }),
    '/ship/ack': () => ({}),
  }, { slow: options.slow });
}

test('the round trip: the probe sends itself a message, receives it and acks it', async () => {
  const ctx = roundTrip({ deliver: true });
  assert.deepEqual(await evaluate(fleetRoundTrip, ctx, timing), { state: 'up', detail: 'a message sent, received and acknowledged' });
  assert.deepEqual(ctx.seen.map((line) => line.split(' ').slice(0, 2).join(' ')), ['GET /ship/whoami', 'POST /ship/send', 'POST /ship/receive', 'POST /ship/ack']);
});

test('the round trip: over 2 s is degraded; a message that never arrives is down', async () => {
  assert.equal((await evaluate(fleetRoundTrip, roundTrip({ deliver: true, slow: 800 }), timing) as { state: string }).state, 'degraded');
  const lost = await evaluate(fleetRoundTrip, roundTrip({ deliver: false }), { ...timing, timeoutMs: 15_000 });
  assert.deepEqual(lost, { state: 'down', detail: 'the probe did not receive its own message' });
});

test('trierarchs: all seen and no request waiting is up', async () => {
  assert.equal((await evaluate(trierarchs, context(listing(healthy())), timing) as { state: string }).state, 'up');
});

test('trierarchs: 1 of 3 unseen is degraded and its detail names counts only', async () => {
  const ships = [...healthy(), ship({ type: 'trierarch', kind: 'trierarch', name: 'c', lastSeenAt: ago(40) })];
  const outcome = await evaluate(trierarchs, context(listing(ships)), timing) as { state: string; detail: string };
  assert.deepEqual(outcome, { state: 'degraded', detail: '1 of 3 trierarchs not seen for 15 minutes' });
  assert.equal(publicDetail(outcome.detail), outcome.detail);
});

test('trierarchs: none seen is down; so is a plugin not seen', async () => {
  const stale = healthy().map((s) => (s.kind === 'trierarch' ? { ...s, lastSeenAt: ago(60) } : s));
  assert.equal((await evaluate(trierarchs, context(listing(stale)), timing) as { state: string }).state, 'down');
  const noPlugin = healthy().filter((s) => s.type !== 'trierarch-plugin');
  assert.equal((await evaluate(trierarchs, context(listing(noPlugin)), timing) as { state: string }).state, 'down');
});

test('trierarchs: crew requests waiting over 15 minutes: some is degraded, every one is down', async () => {
  const waiting = (name: string, minutes: number): ListedShip => ship({ type: 'agent', kind: 'agent', name, status: 'awaitingCrew', crewRequest: { requestedAt: ago(minutes), assignedTo: null, status: null } });
  const one = await evaluate(trierarchs, context(listing([...healthy(), waiting('a', 20), ship({ type: 'agent', kind: 'agent', status: 'awaitingCrew', crewRequest: { requestedAt: ago(2), assignedTo: null, status: null } })])), timing);
  assert.deepEqual(one, { state: 'degraded', detail: '1 of 2 crew requests waiting over 15 minutes' });
  const all = await evaluate(trierarchs, context(listing([...healthy(), waiting('a', 20), waiting('b', 30)])), timing);
  assert.equal((all as { state: string }).state, 'down');
});

test('trierarchs: a single request waiting is every request waiting, so down', async () => {
  const waiting = ship({ type: 'agent', kind: 'agent', status: 'awaitingCrew', crewRequest: { requestedAt: ago(20), assignedTo: null, status: null, crewedBy: null } });
  assert.deepEqual(await evaluate(trierarchs, context(listing([...healthy(), waiting])), timing), { state: 'down', detail: '1 crew request waiting over 15 minutes, none taken up' });
});

test('trierarchs: a request still uncrewed counts as waiting whatever the ship status says', async () => {
  const uncrewed = ship({ type: 'agent', kind: 'agent', status: 'crewed', crewRequest: { requestedAt: ago(20), assignedTo: { id: 'x' }, status: 'starting', crewedBy: null } });
  const crewed = ship({ type: 'agent', kind: 'agent', name: 'c', status: 'crewed', crewRequest: { requestedAt: ago(90), assignedTo: { id: 'x' }, status: 'running', crewedBy: { id: 'x' } } });
  const fresh = ship({ type: 'agent', kind: 'agent', name: 'd', status: 'awaitingCrew', crewRequest: { requestedAt: ago(2), assignedTo: null, status: null, crewedBy: null } });
  assert.deepEqual(await evaluate(trierarchs, context(listing([...healthy(), uncrewed, crewed, fresh])), timing), { state: 'degraded', detail: '1 of 2 crew requests waiting over 15 minutes' });
});

test('trierarchs: a ship the probe cannot read fails the row instead of reading as unseen', async () => {
  const ships = [...healthy(), ship({ type: 'trierarch', kind: 'trierarch', isInReadReach: false, lastSeenAt: null })];
  assert.deepEqual(await evaluate(trierarchs, context(listing(ships)), timing), { state: 'down', detail: 'the probe cannot read every trierarch and plugin' });
});

test('squadrons and the watch plugin: seen is up, not seen is down', async () => {
  assert.equal((await evaluate(squadrons, context(listing(healthy())), timing) as { state: string }).state, 'up');
  assert.equal((await evaluate(watch, context(listing(healthy())), timing) as { state: string }).state, 'up');
  const without = healthy().filter((s) => s.type !== 'squadrons' && s.type !== 'watch');
  assert.deepEqual(await evaluate(squadrons, context(listing(without)), timing), { state: 'down', detail: 'squadrons not seen for 15 minutes' });
  assert.deepEqual(await evaluate(watch, context(listing(without)), timing), new NotChecked('not connected'));
  const stale = healthy().map((s) => (s.type === 'watch' ? { ...s, lastSeenAt: ago(30) } : s));
  assert.equal((await evaluate(watch, context(listing(stale)), timing) as { state: string }).state, 'down');
});

test('the round trip logs every call duration without credentials or payloads', async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (message: string) => { logs.push(message); };
  try {
    assert.deepEqual(await evaluate(fleetRoundTrip, roundTrip({ deliver: true, slow: 100 }), timing), { state: 'up', detail: 'a message sent, received and acknowledged' });
  } finally {
    console.log = original;
  }
  for (const name of ['whoami', 'send', 'receive', 'ack']) {
    assert.ok(logs.some((line) => line.includes(`${name}: 100 ms`)), name);
  }
  assert.doesNotMatch(logs.join('\n'), /secret|shp_probe|status-check/);
});
