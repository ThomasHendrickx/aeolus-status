import { setupTimer } from '../src/timer.ts';
import { probe } from '../src/fleet.ts';
import { realContext } from '../src/context.ts';

const fleet = probe(realContext(), AbortSignal.timeout(120_000));
try {
  const ids = await setupTimer(fleet.call);
  console.log(`Status timer ready: ${ids.length} schedules.`);
  let cursor: string | null = null;
  do {
    const page = await fleet.call('POST', '/ship/schedules', { ...(cursor ? { cursor } : {}) }) as { items: { scheduleId: string; state: string; timing: unknown }[]; nextCursor: string | null };
    for (const schedule of page.items) console.log(JSON.stringify({ scheduleId: schedule.scheduleId, state: schedule.state, timing: schedule.timing }));
    cursor = page.nextCursor;
  } while (cursor);
} catch (error) {
  // Only fixed diagnostics from our code, never gateway payloads or credentials.
  console.error(error instanceof Error ? error.message : 'Status timer setup failed');
  process.exitCode = 1;
}
