/** What a check says of its part: it works, it works worse, or it does not. */
export type State = 'up' | 'degraded' | 'down';

/** How often a check runs: every 5 minutes, or every 15 minutes. */
export type Cadence = 'five' | 'fifteen';

/** A result. `detail` is public: a fixed phrase naming what failed, never an answer's content, a ship, a computer or an account. */
export interface Outcome {
  state: State;
  detail: string;
}

/** An error whose message is a public phrase. Any other error is reported without its message. */
export class Failure extends Error {}

export interface Check<Context> {
  /** The part and what is checked, as the issue title names it: "Fleet core: fleet list". */
  name: string;
  /** The issue label that, with `status`, marks this check's issues. Not one of Upptime's own labels. */
  slug: string;
  cadence: Cadence;
  /** How long one try may take before it counts as no answer: 30 seconds unless the check says. */
  timeoutMs?: number;
  /** `opens` signs the probe account in and keeps the session; `uses` reads pages in that session, so it runs after the one that opens it. */
  session?: 'opens' | 'uses';
  run(context: Context, signal: AbortSignal): Promise<Outcome>;
}

/** Thrown when a check cannot be made for a reason that is not its part's fault: nothing is reported and no issue changes. The message says why, publicly. */
export class NotChecked extends Error {}

/** A secret the check needs is not set. */
export class Unconfigured extends NotChecked {}
