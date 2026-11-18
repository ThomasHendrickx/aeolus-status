import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AssetFailure } from './browser.ts';

test('asset diagnostics remove credentials, queries and sensitive path segments', () => {
  const failure = new AssetFailure(new Map([
    ['https://user:password@assets.example.test/static/app.js?token=private-secret', 'net::ERR_FAILED'],
    ['https://assets.example.test/files/abcdefghijklmnopqrstuvwxyz123456', 'HTTP 403'],
  ]));
  assert.equal(failure.message, '2 assets of the page failed to load: https://assets.example.test/static/app.js (net::ERR_FAILED), https://assets.example.test/files/[redacted] (HTTP 403)');
  assert.doesNotMatch(failure.message, /user|password|private-secret|abcdefghijklmnopqrstuvwxyz123456/);
});
