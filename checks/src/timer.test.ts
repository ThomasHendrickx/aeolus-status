import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupTimer } from './timer.ts';
import { slotKey } from './slot.ts';

test('setup twice creates the same three probe-owned fallback schedules', async () => {
  const stored = new Map<string, Record<string, any>>();
  const calls: string[] = [];
  const call = async (_method: string, path: string, body?: any): Promise<any> => {
    calls.push(path);
    if (path === '/ship/discover') return { ships: [{ name: 'github-actions', verified: [{ checked: 'tlsHost' }], statement: { capabilities: [{ name: 'actions_run_trigger' }] } }] };
    if (path === '/ship/send') return { messageId: 'preflight' };
    if (path === '/ship/receiveReply') return { deliveries: [{ deliveryId: 'reply', payload: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ method: 'run_workflow', dispatch: { status_code: 204, ref: 'main' } }) }] }) }] };
    if (path === '/ship/ack') return {};
    if (path === '/ship/schedule') {
      if (!stored.has(body.idempotencyKey)) stored.set(body.idempotencyKey, body);
      else assert.deepEqual(body, stored.get(body.idempotencyKey));
      return { scheduleId: body.idempotencyKey };
    }
    throw new Error(path);
  };
  const first = await setupTimer(call);
  assert.deepEqual(await setupTimer(call), first);
  assert.equal(stored.size, 3);
  assert.ok(calls.indexOf('/ship/ack') < calls.indexOf('/ship/schedule'));
  const schedules = [...stored.values()];
  assert.deepEqual(schedules.map((s) => s.timing.cron), ['2-59/5 * * * *', '2-59/5 * * * *', '2-59/15 * * * *']);
  assert.deepEqual(schedules.map((s) => JSON.parse(s.payload)), [
    { method: 'run_workflow', owner: 'ThomasHendrickx', repo: 'aeolus-status', ref: 'main', workflow_id: 'uptime.yml', inputs: {} },
    ...['five', 'fifteen'].map((cadence) => ({ method: 'run_workflow', owner: 'ThomasHendrickx', repo: 'aeolus-status', ref: 'main', workflow_id: 'checks.yml', inputs: { cadence, accept_probe_terms: false } })),
  ]);
  for (const schedule of schedules) {
    assert.deepEqual(schedule.selector, { kind: 'ship', name: 'github-actions' });
    assert.equal(schedule.contentType, 'application/vnd.aeolus.mcp-tool+json; name=actions_run_trigger');
    assert.equal(schedule.onMissed, 'skip');
    assert.equal(schedule.onRefused, 'skip');
  }
});

test('a missing checked proxy or dispatch tool stops setup before sending', async () => {
  for (const ships of [[], [{ name: 'github-actions', verified: [], statement: { capabilities: [{ name: 'actions_run_trigger' }] } }], [{ name: 'github-actions', verified: [{ checked: 'tlsHost' }], statement: { capabilities: [] } }]]) {
    await assert.rejects(setupTimer(async (_method, path) => {
      assert.equal(path, '/ship/discover');
      return { ships };
    }), /github-actions/);
  }
});

test('a gateway authorization or scope refusal creates no schedules', async () => {
  await assert.rejects(setupTimer(async (_method, path) => {
    if (path === '/ship/discover') return { ships: [{ name: 'github-actions', verified: [{ checked: 'tlsHost' }], statement: { capabilities: [{ name: 'actions_run_trigger' }] } }] };
    if (path === '/ship/send') return { messageId: 'preflight' };
    if (path === '/ship/receiveReply') return { deliveries: [{ deliveryId: 'reply', payload: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'missing scope' }] }) }] };
    assert.equal(path, '/ship/ack');
    return {};
  }), /preflight/);
});

test('cron and gateway dispatch share UTC slots, with separate cadence and branch keys', () => {
  assert.equal(slotKey('five', '2026-11-18T16:00:20Z'), slotKey('five', '2026-11-18T16:02:20Z'));
  assert.equal(slotKey('fifteen', '2026-11-18T16:00:20Z'), slotKey('fifteen', '2026-11-18T16:14:59Z'));
  assert.notEqual(slotKey('five', '2026-11-18T16:00:20Z'), slotKey('five', '2026-11-18T16:05:00Z'));
  assert.notEqual(slotKey('five', '2026-11-18T16:00:20Z'), slotKey('fifteen', '2026-11-18T16:00:20Z'));
  assert.throws(() => slotKey('other', '2026-11-18T16:00:20Z'));
});
