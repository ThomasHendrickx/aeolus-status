import type { Context } from './context.ts';
import { fleetList, fleetRoundTrip } from './checks/fleet-core.ts';
import { squadrons, trierarchs, watch } from './checks/fleet-ships.ts';
import type { Check } from './types.ts';

/** Every check, one file each, in the order of the table of what healthy means. */
export const checks: Check<Context>[] = [fleetList, fleetRoundTrip, trierarchs, squadrons, watch];
