import type { Context } from './context.ts';
import type { Check } from './types.ts';

/** Every check, one file each, in the order of the table of what healthy means. */
export const checks: Check<Context>[] = [];
