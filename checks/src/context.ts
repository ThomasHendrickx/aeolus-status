/** What a check may use: the secrets it names in the environment, and the network. Tests hand in fakes. */
export interface Context {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now(): number;
}

export function realContext(): Context {
  return { env: process.env, fetch, now: () => Date.now() };
}
