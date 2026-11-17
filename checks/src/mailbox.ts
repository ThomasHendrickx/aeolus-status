import type { Context } from './context.ts';
import { Failure, Unconfigured } from './types.ts';

const DEFAULT_MAIL_API = 'https://api.mail.tm';
const MAIL_WAIT_MS = 150_000;
const POLL_MS = 3_000;
/** The mailbox provider limits requests per address: a 429 is retried this many times, waiting longer each time (2 s, 4 s, 6 s, 8 s). */
const RETRIES_ON_429 = 4;
const BACKOFF_MS = 2_000;

interface Message {
  id: string;
}

/** The probe account's mailbox on mail.tm, a free inbox with an API (design H1): signs in with PROBE_MAIL_ADDRESS and PROBE_MAIL_PASSWORD. */
export function mailbox(context: Context): {
  address: string;
  purge(): Promise<void>;
  waitForLink(origin: string, signal: AbortSignal): Promise<string>;
} {
  const { PROBE_MAIL_ADDRESS: address, PROBE_MAIL_PASSWORD: password, MAIL_API: api = DEFAULT_MAIL_API } = context.env;
  if (!address || !password) {
    throw new Unconfigured('PROBE_MAIL_ADDRESS and PROBE_MAIL_PASSWORD');
  }
  let token: string | undefined;
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    token ??= ((await (await context.fetch(`${api}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, password }) })).json()) as { token?: string }).token;
    if (!token) {
      throw new Failure('the probe mailbox did not accept its login');
    }
    const backoff = Number(context.env.MAIL_BACKOFF_MS ?? BACKOFF_MS);
    let response: Response;
    for (let attempt = 1; ; attempt += 1) {
      response = await context.fetch(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status !== 429 || attempt > RETRIES_ON_429) {
        break;
      }
      await new Promise((done) => setTimeout(done, backoff * attempt));
    }
    if (!response.ok) {
      throw new Failure(`the probe mailbox answered ${String(response.status)}`);
    }
    return response.status === 204 ? null : response.json();
  }
  async function messages(): Promise<Message[]> {
    return ((await call('GET', '/messages')) as { 'hydra:member'?: Message[] })['hydra:member'] ?? [];
  }
  return {
    address,
    /** Empties the inbox, so the next mail is the one just asked for. */
    async purge() {
      for (const message of await messages()) {
        await call('DELETE', `/messages/${message.id}`);
      }
    },
    /** The first link on the account's own origin in the next mail, read and deleted; fails when none arrives in time (2.5 minutes) or the signal aborts. */
    async waitForLink(origin, signal) {
      const deadline = context.now() + Number(context.env.MAIL_WAIT_MS ?? MAIL_WAIT_MS);
      while (context.now() < deadline && !signal.aborted) {
        const [message] = await messages();
        if (message) {
          const full = (await call('GET', `/messages/${message.id}`)) as { text?: string; html?: string[] };
          await call('DELETE', `/messages/${message.id}`);
          const text = `${full.text ?? ''} ${(full.html ?? []).join(' ')}`.replaceAll('&amp;', '&');
          const link = text.match(/https?:\/\/[^\s"'<>)]+/g)?.find((candidate) => candidate.startsWith(`${origin}/`));
          if (!link) {
            throw new Failure('the sign-in mail held no sign-in link');
          }
          return link;
        }
        await new Promise((done) => setTimeout(done, POLL_MS));
      }
      throw new Failure('no sign-in mail arrived in time');
    },
  };
}
