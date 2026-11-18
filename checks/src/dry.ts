/** Only runs on main may change incident issues. */
export function isDry(ref: string | undefined, requested: boolean): boolean {
  return requested || ref !== 'refs/heads/main';
}
