import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluate, publicDetail, tryOnce } from './engine.ts';
import { type Check, Failure, type Outcome, Unconfigured } from './types.ts';

const fast = { timeoutMs: 50, retryDelayMs: 0, sleep: () => Promise.resolve() };

function check(...answers: (Outcome | Error | 'hang')[]): { check: Check<null>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    check: {
      name: 'Part: thing',
      slug: 'check-part',
      cadence: 'five',
      run: (_, signal) => {
        const answer = answers[Math.min(calls++, answers.length - 1)] as Outcome | Error | 'hang';
        if (answer === 'hang') {
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        }
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
}

test('an up or degraded result is taken at the first try', async () => {
  const up = check({ state: 'up', detail: 'ok' });
  assert.deepEqual(await evaluate(up.check, null, fast), { state: 'up', detail: 'ok' });
  assert.equal(up.calls(), 1);
  const slow = check({ state: 'degraded', detail: 'answered in 3 s' });
  assert.deepEqual(await evaluate(slow.check, null, fast), { state: 'degraded', detail: 'answered in 3 s' });
  assert.equal(slow.calls(), 1);
});

test('one down try is not down: the second try, a minute later, stands', async () => {
  const waits: number[] = [];
  const timing = { ...fast, retryDelayMs: 60_000, sleep: (ms: number) => { waits.push(ms); return Promise.resolve(); } };
  const lost = check(new Failure('answered 502'), { state: 'up', detail: 'ok' });
  assert.deepEqual(await evaluate(lost.check, null, timing), { state: 'up', detail: 'ok' });
  assert.deepEqual(waits, [60_000]);
  const down = check(new Failure('answered 502'));
  assert.deepEqual(await evaluate(down.check, null, timing), { state: 'down', detail: 'answered 502' });
  assert.equal(down.calls(), 2);
});

test('no answer within the timeout is down, and its message says so', async () => {
  const hung = check('hang');
  assert.deepEqual(await tryOnce(hung.check, null, 20), { state: 'down', detail: 'no answer within 0.02 seconds' });
});

test('an error that is no Failure is down without its message', async () => {
  const outcome = await tryOnce(check(new Error('fetch failed for https://secret.example/x')).check, null, 50);
  assert.deepEqual(outcome, { state: 'down', detail: 'the check could not complete' });
});

test('a detail that holds an id, an address, a link or a long token is withheld', () => {
  for (const leak of ['ship shp_01m3tb1zhjs6kthtcs2zvksacv', 'mail to a@b.dev', 'see https://x.dev', 'token abcdefghijklmnopqrstuvwxyz', 'host 10.0.0.1', 'x'.repeat(201)]) {
    assert.match(publicDetail(leak), /withheld/);
  }
  assert.equal(publicDetail('1 of 3 trierarchs not seen for 15 minutes'), '1 of 3 trierarchs not seen for 15 minutes');
});

test('a check whose secret is not set is not checked, and not tried again', async () => {
  const unset = check(new Unconfigured('FLEET_PROBE_TOKEN'));
  assert.ok((await evaluate(unset.check, null, fast)) instanceof Unconfigured);
  assert.equal(unset.calls(), 1);
});
