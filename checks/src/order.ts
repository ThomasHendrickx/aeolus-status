import type { Check } from './types.ts';

/** Runs every check at once, except that the ones that use the signed-in session wait for the ones that open it. */
export async function inOrder<Item extends Pick<Check<never>, 'session'>, Result>(checks: Item[], run: (check: Item) => Promise<Result>): Promise<Result[]> {
  const opening = checks.filter((check) => check.session === 'opens');
  const using = checks.filter((check) => check.session === 'uses');
  const independent = checks.filter((check) => check.session === undefined);
  const afterSignIn = async (): Promise<Result[]> => [...(await Promise.all(opening.map(run))), ...(await Promise.all(using.map(run)))];
  const [alone, signed] = await Promise.all([Promise.all(independent.map(run)), afterSignIn()]);
  return [...alone, ...signed];
}
