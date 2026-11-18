import { randomUUID } from 'node:crypto';

type Call = (method: 'GET' | 'POST', path: string, body?: any) => Promise<any>;

const contentType = 'application/vnd.aeolus.mcp-tool+json; name=actions_run_trigger';
const dispatch = (workflow: string, inputs: Record<string, unknown>) => ({
  method: 'run_workflow', owner: 'ThomasHendrickx', repo: 'aeolus-status', ref: 'main', workflow_id: workflow, inputs,
});

/** Run as the status probe during setup. The fleet retains its schedules without a running crew. */
export async function setupTimer(call: Call): Promise<string[]> {
  const discovery = await call('GET', '/ship/discover');
  const github = discovery.ships?.find((ship: any) => ship.name === 'github-actions');
  if (!github?.verified?.some((fact: any) => fact.checked === 'tlsHost') ||
      !github.statement?.capabilities?.some((tool: any) => tool.name === 'actions_run_trigger')) {
    throw new Error('github-actions must be reachable, checked, and advertise actions_run_trigger');
  }
  // A real dispatch proves the probe's send reach, gateway scopes and gateway-held GitHub authorization.
  // This call is never retried automatically: a lost reply requires inspection in Bridge.
  const { messageId } = await call('POST', '/ship/send', {
    selector: { kind: 'ship', name: 'github-actions' }, contentType,
    payload: JSON.stringify(dispatch('uptime.yml', {})), model: 'none', idempotencyKey: `status-timer-preflight-${randomUUID()}`,
  });
  let passed = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const reply = await call('POST', '/ship/receiveReply', { messageId });
    const delivery = reply.deliveries?.[0];
    if (!delivery) {
      await new Promise((done) => setTimeout(done, 1_000));
      continue;
    }
    const result = JSON.parse(delivery.payload);
    await call('POST', '/ship/ack', { deliveryId: delivery.deliveryId });
    const response = result.structuredContent ?? result.content?.filter((item: any) => item.type === 'text').map((item: any) => {
      try { return JSON.parse(item.text); } catch { return null; }
    }).find((item: any) => item?.dispatch);
    passed = !result.isError && response?.dispatch?.status_code === 204 && response.dispatch.ref === 'main';
    if (!passed) throw new Error('github-actions preflight failed; check the probe scopes and gateway GitHub authorization in Bridge');
    break;
  }
  if (!passed) throw new Error('github-actions preflight has no reply; inspect the gateway call before retrying');
  const schedules = [
    ['uptime', '2-59/5 * * * *', dispatch('uptime.yml', {})],
    ['five', '2-59/5 * * * *', dispatch('checks.yml', { cadence: 'five', accept_probe_terms: false })],
    ['fifteen', '2-59/15 * * * *', dispatch('checks.yml', { cadence: 'fifteen', accept_probe_terms: false })],
  ] as const;
  const ids: string[] = [];
  for (const [name, cron, payload] of schedules) {
    const { scheduleId } = await call('POST', '/ship/schedule', {
      selector: { kind: 'ship', name: 'github-actions' }, contentType,
      payload: JSON.stringify(payload), model: 'none', idempotencyKey: `status-timer-${name}-v1`,
      timing: { kind: 'cron', cron, timeZone: 'UTC' }, onRefused: 'skip', onMissed: 'skip', grace: 'PT1M',
    });
    ids.push(scheduleId);
  }
  return ids;
}
