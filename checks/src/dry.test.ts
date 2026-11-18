import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isDry } from './dry.ts';

test('only main can sync incidents, unless dry is requested', () => {
  assert.equal(isDry('refs/heads/main', false), false);
  assert.equal(isDry('refs/heads/main', true), true);
  for (const ref of ['refs/heads/feature', 'refs/tags/main', 'refs/pull/1/merge', undefined]) {
    assert.equal(isDry(ref, false), true);
  }
});
