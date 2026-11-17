import type { Context } from '../context.ts';
import { probe } from '../fleet.ts';
import { type Check, Failure } from '../types.ts';

export const SLOW_MS = 2_000;
const POLLS = 20;
const POLL_MS = 500;

/** Fleet core and database, 1: the list answers with a trierarch ship in it: a real read of the database. Slower than 2 s is degraded. */
export const fleetList: Check<Context> = {
  name: 'Fleet core: fleet list',
  slug: 'check-fleet-list',
  cadence: 'five',
  async run(context, signal) {
    const started = context.now();
    const ships = await probe(context, signal).list();
    const took = context.now() - started;
    if (!ships.some((ship) => ship.kind === 'trierarch')) {
      return { state: 'down', detail: 'the fleet list holds no trierarch ship' };
    }
    return took > SLOW_MS
      ? { state: 'degraded', detail: `the fleet list took ${String(Math.round(took / 100) / 10)} s` }
      : { state: 'up', detail: 'the fleet list answers' };
  },
};

/** Fleet core and database, 2: the probe sends itself a message, receives it and acks it: a real write. It touches no other ship. */
export const fleetRoundTrip: Check<Context> = {
  name: 'Fleet core: message round trip',
  slug: 'check-fleet-round-trip',
  cadence: 'five',
  async run(context, signal) {
    const started = context.now();
    const fleet = probe(context, signal);
    const me = (await fleet.call('GET', '/ship/whoami')) as { shipId?: string };
    if (!me.shipId) {
      throw new Failure('the probe could not be identified');
    }
    const nonce = `status-check ${context.now()}-${Math.random().toString(36).slice(2)}`;
    await fleet.call('POST', '/ship/send', {
      selector: { kind: 'ship', shipId: me.shipId },
      payload: nonce,
      contentType: 'text/plain',
      model: 'none',
      idempotencyKey: nonce.replaceAll(' ', '-'),
    });
    for (let poll = 0; poll < POLLS; poll += 1) {
      const answer = (await fleet.call('POST', '/ship/receive', { max: 10 })) as { deliveries?: { deliveryId: string; payload: string }[] };
      const mine = (answer.deliveries ?? []).filter((delivery) => delivery.payload.startsWith('status-check '));
      for (const delivery of mine) {
        await fleet.call('POST', '/ship/ack', { deliveryId: delivery.deliveryId });
      }
      if (mine.some((delivery) => delivery.payload === nonce)) {
        const took = context.now() - started;
        return took > SLOW_MS
          ? { state: 'degraded', detail: `the message round trip took ${String(Math.round(took / 100) / 10)} s` }
          : { state: 'up', detail: 'a message sent, received and acknowledged' };
      }
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
    return { state: 'down', detail: 'the probe did not receive its own message' };
  },
};
