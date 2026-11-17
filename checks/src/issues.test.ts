import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Github, syncIssue, titleOf } from './issues.ts';

const check = { name: 'Fleet core: fleet list', slug: 'check-fleet-list' };

function fake(open: { number: number; title: string }[]): { github: Github; calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] } {
  const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
  const fakeFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(url).replace('https://api.github.com/repos/o/r', '');
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    return Promise.resolve(Response.json(init?.method === 'GET' ? open : {}));
  };
  return {
    calls,
    github: { repository: 'o/r', token: 't', assignees: ['someone'], runUrl: 'https://github.com/o/r/actions/runs/1', fetch: fakeFetch as typeof fetch, now: () => new Date('2026-11-17T10:00:00Z') },
  };
}

test('a down check with no open issue opens one labelled status and its slug, with Upptime\'s title', async () => {
  const { github, calls } = fake([]);
  assert.equal(await syncIssue(github, check, { state: 'down', detail: 'answered 500' }), 'opened');
  assert.equal(calls[0]?.path, '/issues?labels=status%2Ccheck-fleet-list&state=open&per_page=10');
  const created = calls[1];
  assert.equal(created?.method, 'POST');
  assert.equal(created?.body?.title, '🛑 Fleet core: fleet list is down');
  assert.deepEqual(created?.body?.labels, ['status', 'check-fleet-list']);
  assert.deepEqual(created?.body?.assignees, ['someone']);
  assert.match(String(created?.body?.body), /What failed: answered 500/);
});

test('a degraded check opens the degraded title', async () => {
  const { github, calls } = fake([]);
  await syncIssue(github, check, { state: 'degraded', detail: 'took 3 s' });
  assert.equal(calls[1]?.body?.title, titleOf(check.name, 'degraded'));
  assert.match(titleOf(check.name, 'degraded'), /^⚠️ .* has degraded performance$/);
});

test('a check still down with its issue open changes nothing', async () => {
  const { github, calls } = fake([{ number: 7, title: titleOf(check.name, 'down') }]);
  assert.equal(await syncIssue(github, check, { state: 'down', detail: 'answered 500' }), 'unchanged');
  assert.equal(calls.length, 1);
});

test('a check that went from degraded to down retitles its issue and comments', async () => {
  const { github, calls } = fake([{ number: 7, title: titleOf(check.name, 'degraded') }]);
  assert.equal(await syncIssue(github, check, { state: 'down', detail: 'answered 500' }), 'updated');
  assert.deepEqual(calls.slice(1).map((call) => `${call.method} ${call.path}`), ['PATCH /issues/7', 'POST /issues/7/comments']);
});

test('an up check closes its open issue after a Resolved comment, and does nothing without one', async () => {
  const { github, calls } = fake([{ number: 7, title: titleOf(check.name, 'down') }]);
  assert.equal(await syncIssue(github, check, { state: 'up', detail: 'ok' }), 'closed');
  assert.match(String(calls[1]?.body?.body), /^\*\*Resolved:\*\* Fleet core: fleet list is back up/);
  assert.deepEqual(calls[2]?.body, { state: 'closed', state_reason: 'completed' });
  const none = fake([]);
  assert.equal(await syncIssue(none.github, check, { state: 'up', detail: 'ok' }), 'unchanged');
  assert.equal(none.calls.length, 1);
});
