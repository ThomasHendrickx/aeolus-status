import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AssetFailure } from './browser.ts';

test('asset diagnostics remove credentials, queries and sensitive path segments', () => {
  const failure = new AssetFailure(new Map([
    ['https://user:password@assets.example.test/static/app.js?token=private-secret', 'net::ERR_FAILED'],
    ['https://assets.example.test/files/abcdefghijklmnopqrstuvwxyz123456', 'HTTP 403'],
    ['https://assets.example.test/token/short-secret-value', 'HTTP 403'],
  ]));
  assert.equal(failure.message, '3 assets of the page failed to load: https://assets.example.test/static/app.js (net::ERR_FAILED), https://assets.example.test/files/[redacted] (HTTP 403), https://assets.example.test/[redacted]/[redacted] (HTTP 403)');
  assert.doesNotMatch(failure.message, /user|password|private-secret|short-secret-value|abcdefghijklmnopqrstuvwxyz123456/);
});

test('console timing reports visibility, network idle and slow request paths safely', async () => {
  const { loadWithAssets } = await import('./browser.ts');
  const handlers = new Map<string, (request: any) => void>();
  const logs: string[] = [];
  const original = console.log;
  console.log = (message: string) => { logs.push(message); };
  let clock = 100;
  const request = { url: () => 'https://user:password@example.test/api/token/short-secret?token=private', timing: () => ({ startTime: 100, responseEnd: 35 }) };
  const page = {
    on: (event: string, handler: (request: any) => void) => { handlers.set(event, handler); },
    locator: (selector: string) => selector.startsWith('link')
      ? { evaluateAll: async () => [] }
      : { first: () => ({ waitFor: async () => { clock = 125; } }) },
    goto: async () => { await Promise.resolve(); handlers.get('requestfinished')?.(request); clock = 150; },
  };
  try {
    await loadWithAssets(page as never, 'https://example.test/', { consoleTiming: true, now: () => clock });
  } finally {
    console.log = original;
  }
  assert.match(logs.join('\n'), /first ship visible: 25 ms/);
  assert.match(logs.join('\n'), /network idle: 50 ms/);
  assert.match(logs.join('\n'), /\/api\/\[redacted\]\/\[redacted\].*35 ms/);
  assert.doesNotMatch(logs.join('\n'), /password|short-secret|private|example\.test/);
});
