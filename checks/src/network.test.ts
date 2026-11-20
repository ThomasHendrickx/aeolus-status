import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fleetFetch } from './network.ts';

test('fleet calls log connection phases and reuse without request or response data', async () => {
  const traceparents: (string | undefined)[] = [];
  const server = createServer((req, res) => { traceparents.push(req.headers.traceparent); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
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
  const traceIds: string[] = [];
  for (const [index, header] of traceparents.entries()) {
    assert.ok(header);
    assert.match(header, /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-01$/);
    const traceId = header.split('-')[1]!;
    traceIds.push(traceId);
    assert.match(logs[index]!, new RegExp(`trace_id=${traceId}(?: |$)`));
  }
  assert.equal(traceparents.length, 2);
  assert.notEqual(traceIds[0], traceIds[1]);
  for (const line of logs) {
    assert.match(line, /dns=.*connect=.*tls=.*ttfb=.*reused=/);
    assert.doesNotMatch(line, /secret|private|localhost|ok/);
  }
  assert.match(logs[0]!, /reused=false/);
  assert.match(logs[1]!, /reused=true/);
});
