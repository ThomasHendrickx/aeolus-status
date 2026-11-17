import { type Check, Failure, type Outcome } from './types.ts';

export const TIMEOUT_MS = 30_000;
export const RETRY_DELAY_MS = 60_000;

const WITHHELD = 'the result was withheld, as it held more than the part and what failed';

/** A detail that could name a ship, an account, an address or a secret is replaced: results are public. */
export function publicDetail(detail: string): string {
  const leaks = /shp_|@|https?:|\/\/|[A-Za-z0-9_-]{24,}|\d+\.\d+\.\d+\.\d+/;
  return detail.length > 200 || leaks.test(detail) ? WITHHELD : detail;
}

/** One try: the check's outcome; a Failure is down with its phrase; any other error or a lost answer within the timeout is down without the error's message. */
export async function tryOnce<Context>(check: Check<Context>, context: Context, timeoutMs: number): Promise<Outcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const outcome = await Promise.race([
      check.run(context, controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Failure(`no answer within ${String(timeoutMs / 1000)} seconds`)));
      }),
    ]);
    return { state: outcome.state, detail: publicDetail(outcome.detail) };
  } catch (error) {
    if (timedOut) {
      return { state: 'down', detail: `no answer within ${String(timeoutMs / 1000)} seconds` };
    }
    return { state: 'down', detail: error instanceof Failure ? publicDetail(error.message) : 'the check could not complete' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export interface Timing {
  timeoutMs: number;
  retryDelayMs: number;
  sleep(ms: number): Promise<void>;
}

export const realTiming: Timing = {
  timeoutMs: TIMEOUT_MS,
  retryDelayMs: RETRY_DELAY_MS,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/** Down only when two tries in a row, a minute apart, are down: one lost packet is not an incident. The second try's outcome stands. */
export async function evaluate<Context>(check: Check<Context>, context: Context, timing: Timing = realTiming): Promise<Outcome> {
  const first = await tryOnce(check, context, timing.timeoutMs);
  if (first.state !== 'down') {
    return first;
  }
  await timing.sleep(timing.retryDelayMs);
  return tryOnce(check, context, timing.timeoutMs);
}
