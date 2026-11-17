import type { Context } from '../context.ts';
import { type ListedShip, minutesSince, probe } from '../fleet.ts';
import { type Check, Failure, type Outcome } from '../types.ts';

/** How long a ship may go unseen, and a crew request unassigned, before it counts: 15 minutes, as the design says. */
export const SEEN_MINUTES = 15;

function readable(ships: ListedShip[]): void {
  if (ships.some((ship) => ship.isInReadReach === false && ['trierarch', 'plugin'].includes(ship.kind))) {
    throw new Failure('the probe cannot read every trierarch and plugin');
  }
}

/** Trierarch plugin and the computers' trierarchs: each trierarch and the plugin seen within 15 minutes, no crew request waiting over 15 minutes. */
export const trierarchs: Check<Context> = {
  name: 'Trierarch plugin and trierarchs',
  slug: 'check-trierarchs',
  cadence: 'five',
  async run(context, signal) {
    const ships = await probe(context, signal).list();
    readable(ships);
    const trierarchs = ships.filter((ship) => ship.kind === 'trierarch' && ship.status !== 'retired');
    const unseen = trierarchs.filter((ship) => minutesSince(context, ship.lastSeenAt) > SEEN_MINUTES).length;
    const pluginSeen = ships.some((ship) => ship.type === 'trierarch-plugin' && minutesSince(context, ship.lastSeenAt) <= SEEN_MINUTES);
    const requests = ships.filter((ship) => ship.status === 'awaitingCrew' && ship.crewRequest);
    const waiting = requests.filter((ship) => minutesSince(context, ship.crewRequest?.requestedAt) > SEEN_MINUTES).length;
    if (trierarchs.length === 0 || unseen === trierarchs.length) {
      return { state: 'down', detail: `no trierarch seen for ${String(SEEN_MINUTES)} minutes` };
    }
    if (!pluginSeen) {
      return { state: 'down', detail: `the trierarch plugin not seen for ${String(SEEN_MINUTES)} minutes` };
    }
    if (waiting >= 2 && waiting === requests.length) {
      return { state: 'down', detail: `${String(waiting)} crew requests waiting over ${String(SEEN_MINUTES)} minutes, none taken up` };
    }
    const parts: string[] = [];
    if (unseen > 0) {
      parts.push(`${String(unseen)} of ${String(trierarchs.length)} trierarchs not seen for ${String(SEEN_MINUTES)} minutes`);
    }
    if (waiting > 0) {
      parts.push(`${String(waiting)} of ${String(requests.length)} crew requests waiting over ${String(SEEN_MINUTES)} minutes`);
    }
    return parts.length > 0 ? { state: 'degraded', detail: parts.join('; ') } : { state: 'up', detail: 'every trierarch seen, no crew request waiting' };
  },
};

/** A plugin ship of a type, seen within 15 minutes: down when it is not. */
function pluginSeen(name: string, slug: string, what: string, typeFrom: (context: Context) => string): Check<Context> {
  return {
    name,
    slug,
    cadence: 'five',
    async run(context, signal): Promise<Outcome> {
      const ships = await probe(context, signal).list();
      readable(ships);
      const type = typeFrom(context);
      const seen = ships.some((ship) => ship.type === type && ship.status !== 'retired' && minutesSince(context, ship.lastSeenAt) <= SEEN_MINUTES);
      return seen ? { state: 'up', detail: `${what} seen` } : { state: 'down', detail: `${what} not seen for ${String(SEEN_MINUTES)} minutes` };
    },
  };
}

export const squadrons = pluginSeen('squadrons', 'check-squadrons', 'squadrons', () => 'squadrons');

/** The watch plugin's ship type is WATCH_PLUGIN_TYPE, "watch" when unset. */
export const watch = pluginSeen('Watch plugin', 'check-watch', 'the watch plugin', (context) => context.env.WATCH_PLUGIN_TYPE ?? 'watch');
