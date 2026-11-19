import { fleetFetch } from './network.ts';

/** What a check may use: the secrets it names in the environment, and the network. Tests hand in fakes. */
export interface Context {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now(): number;
  fleetFetch?: typeof fetch;
}

export function realContext(): Context {
  return { env: process.env, fetch, fleetFetch, now: () => Date.now() };
}
