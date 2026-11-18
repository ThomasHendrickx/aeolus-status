import { setupTimer } from '../src/timer.ts';
import { probe } from '../src/fleet.ts';
import { realContext } from '../src/context.ts';

const fleet = probe(realContext(), AbortSignal.timeout(120_000));
try {
  const ids = await setupTimer(fleet.call);
  console.log(`Status timer ready: ${ids.length} schedules.`);
} catch (error) {
  // Only fixed diagnostics from our code, never gateway payloads or credentials.
  console.error(error instanceof Error ? error.message : 'Status timer setup failed');
  process.exitCode = 1;
}
