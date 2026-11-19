import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fleetFetch } from './network.ts';

test('fleet calls log connection phases and reuse without request or response data', async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const logs: string[] = [];
  const original = console.log;
  console.log = (line: string) => logs.push(line);
  try {
    const url = `http://localhost:${address.port}/api/v1/fleet/list`;
    for (let i = 0; i < 2; i++) {
      const response = await fleetFetch(url, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: 'private payload' });
      assert.deepEqual(await response.json(), { ok: true });
    }
  } finally {
    console.log = original;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(logs.length, 2);
  for (const line of logs) {
    assert.match(line, /dns=.*connect=.*tls=.*ttfb=.*reused=/);
    assert.doesNotMatch(line, /secret|private|localhost|ok/);
  }
  assert.match(logs[0]!, /reused=false/);
  assert.match(logs[1]!, /reused=true/);
});
