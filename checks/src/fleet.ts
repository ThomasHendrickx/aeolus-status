import type { Context } from './context.ts';
import { Failure, Unconfigured } from './types.ts';

const DEFAULT_FLEET = 'https://fleet.aeolus-fleet.dev'; // public URL; privacy-guard: allow ssh-alias
const PAGES = 10;

/** The part of a ship in the fleet list that the checks read. */
export interface ListedShip {
  id: string;
  name: string;
  type: string;
  kind: string;
  status: 'awaitingCrew' | 'crewed' | 'retired';
  lastSeenAt: string | null;
  isInReadReach?: boolean;
  crewRequest?: { requestedAt: string; assignedTo: unknown; status: string | null; crewedBy?: unknown } | null;
}

/** The probe: a read-only ship of its own whose crew token is the repository secret FLEET_PROBE_TOKEN. */
export function probe(context: Context, signal: AbortSignal): {
  call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
  list(): Promise<ListedShip[]>;
} {
  const token = context.env.FLEET_PROBE_TOKEN;
  if (!token) {
    throw new Unconfigured('FLEET_PROBE_TOKEN');
  }
  const base = `${context.env.FLEET_URL ?? DEFAULT_FLEET}/api/v1`;
  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await (context.fleetFetch ?? context.fetch)(`${base}${path}`, {
      method,
      signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Failure(`the fleet answered ${String(response.status)} to ${path}`);
    }
    return response.json();
  }
  async function list(): Promise<ListedShip[]> {
    const ships: ListedShip[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < PAGES; page += 1) {
      const answer = (await call('POST', '/fleet/list', { limit: 500, ...(cursor ? { cursor } : {}) })) as { items?: ListedShip[]; nextCursor?: string | null };
      if (!Array.isArray(answer.items)) {
        throw new Failure('the fleet list had an unexpected shape');
      }
      ships.push(...answer.items);
      cursor = answer.nextCursor ?? null;
      if (!cursor) {
        return ships;
      }
    }
    throw new Failure('the fleet list did not end');
  }
  return { call, list };
}

/** Minutes since an ISO time, or Infinity when there is none. */
export function minutesSince(context: Context, iso: string | null | undefined): number {
  return iso ? (context.now() - Date.parse(iso)) / 60_000 : Number.POSITIVE_INFINITY;
}
