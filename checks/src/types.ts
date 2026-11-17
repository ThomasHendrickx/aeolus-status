/** What a check says of its part: it works, it works worse, or it does not. */
export type State = 'up' | 'degraded' | 'down';

/** How often a check runs: every 5 minutes, every 15 minutes, or every hour. */
export type Cadence = 'five' | 'fifteen' | 'hourly';

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
  run(context: Context, signal: AbortSignal): Promise<Outcome>;
}
