import { type Browser, type BrowserContext, chromium } from 'playwright';

import type { Context } from './context.ts';
import { mailbox } from './mailbox.ts';
import { Failure, NotChecked, Unconfigured } from './types.ts';

export const URLS = {
  account: 'https://account.aeolus-fleet.dev',
  gateway: 'https://gateway.aeolus-fleet.dev',
  app: 'https://app.aeolus-fleet.dev',
};

export function urlOf(context: Context, name: keyof typeof URLS): string {
  return context.env[`${name.toUpperCase()}_URL`] ?? URLS[name];
}

/** The probe account signed in once per run, shared by the checks that need it: they read pages of their own in this one browser context. */
export interface Session {
  browser: Browser;
  context: BrowserContext;
  /** How long the sign-in mail took to arrive, in milliseconds. */
  mailMs: number;
}

const sessions = new WeakMap<Context, Promise<Session>>();

/** Signs in as a person does: asks for a link on the account app's sign-in page, reads it from the probe mailbox, opens it. */
async function signIn(context: Context): Promise<Session> {
  const inbox = mailbox(context);
  const account = urlOf(context, 'account');
  const browser = await chromium.launch();
  try {
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    page.setDefaultTimeout(20_000);
    await inbox.purge();
    try {
      await page.goto(`${account}/sign-in`);
      await page.getByLabel('Email').fill(inbox.address);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('heading', { name: 'Check your mail' }).waitFor();
    } catch {
      throw new Failure('the sign-in page did not take an email');
    }
    const asked = context.now();
    const link = await inbox.waitForLink(new URL(account).origin);
    const mailMs = context.now() - asked;
    try {
      await page.goto(link);
      await page.waitForURL((url) => url.origin === new URL(urlOf(context, 'gateway')).origin && url.pathname === '/bridge');
    } catch {
      throw new Failure('the sign-in link did not sign in');
    }
    await page.close();
    return { browser, context: browserContext, mailMs };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/** The run's signed-in session. A failed sign-in is not kept, so the next try signs in again. */
export function session(context: Context): Promise<Session> {
  let opened = sessions.get(context);
  if (!opened) {
    opened = signIn(context);
    sessions.set(context, opened);
    opened.catch(() => sessions.delete(context));
  }
  return opened;
}

/** For a check that needs the session but is not the sign-in's: a failed sign-in is the sign-in check's to report, so this one is not checked. */
export async function sessionOrNotChecked(context: Context): Promise<Session> {
  try {
    return await session(context);
  } catch (error) {
    throw error instanceof Unconfigured || error instanceof NotChecked ? error : new NotChecked('the probe could not sign in, see the sign-in check');
  }
}

export async function closeSession(context: Context): Promise<void> {
  const opened = sessions.get(context);
  sessions.delete(context);
  await opened?.then((open) => open.browser.close()).catch(() => undefined);
}
