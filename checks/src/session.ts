import { type Browser, type BrowserContext, chromium } from 'playwright';

import type { Context } from './context.ts';
import { mailbox } from './mailbox.ts';
import { Failure, NotChecked } from './types.ts';

export const URLS = {
  account: 'https://account.aeolus-fleet.dev',
  gateway: 'https://gateway.aeolus-fleet.dev',
  app: 'https://app.aeolus-fleet.dev',
};

export function urlOf(context: Context, name: keyof typeof URLS): string {
  return context.env[`${name.toUpperCase()}_URL`] ?? URLS[name];
}

/** The probe account signed in once per run, shared by the checks that use it: they read pages of their own in this one browser context. */
export interface Session {
  browser: Browser;
  context: BrowserContext;
  /** How long the sign-in mail took to arrive, in milliseconds. */
  mailMs: number;
  /** A signed-in probe whose terms need consent cannot open the dependent app pages yet. */
  needsTerms: boolean;
}

const sessions = new WeakMap<Context, Session>();

/** Signs in as a person does: asks for a link on the account app's sign-in page, reads it from the probe mailbox, opens it. Stops when the signal aborts. */
async function signIn(context: Context, signal: AbortSignal): Promise<Session> {
  const inbox = mailbox(context);
  const account = urlOf(context, 'account');
  const browser = await chromium.launch();
  const close = (): void => void browser.close().catch(() => undefined);
  signal.addEventListener('abort', close);
  try {
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    page.setDefaultTimeout(20_000);
    await inbox.purge();
    try {
      await page.goto(`${account}/sign-in`);
      await page.getByLabel('Email').fill(inbox.address);
      await page.getByRole('button', { name: 'Email me a link' }).click();
      await page.getByRole('heading', { name: 'Check your mail' }).waitFor();
    } catch {
      throw new Failure('the sign-in page did not take an email');
    }
    const asked = context.now();
    const link = await inbox.waitForLink(new URL(account).origin, signal);
    const mailMs = context.now() - asked;
    try {
      await page.goto(link);
      const home = page.getByRole('heading', { name: 'Home', exact: true });
      const signedInTerms = page.getByText(/^Signed in as /);
      const chooseOrganisation = page.getByRole('heading', { name: 'Choose your organisation', exact: true });
      await home.or(signedInTerms).or(chooseOrganisation).first().waitFor();
      if (await chooseOrganisation.isVisible()) {
        const organisation = context.env.PROBE_ORGANISATION;
        if (!organisation) {
          throw new NotChecked('the probe organisation is not configured');
        }
        const choice = page.getByRole('button', { name: organisation, exact: true });
        if (await choice.count() !== 1) {
          throw new Failure('the configured probe organisation was not offered');
        }
        await choice.click();
      }
      await page.waitForURL((url) => url.origin === new URL(account).origin && ['/account', '/welcome'].includes(url.pathname));
      if (new URL(page.url()).pathname === '/welcome') {
        await signedInTerms.waitFor();
        if (context.env.ACCEPT_PROBE_TERMS === 'true') {
          await page.getByRole('checkbox', { name: /I accept/ }).check();
          await page.getByRole('button', { name: 'Continue', exact: true }).click();
          await page.waitForURL((url) => url.origin === new URL(account).origin && url.pathname === '/account');
          await home.waitFor();
        }
      } else {
        await home.waitFor();
      }
    } catch (error) {
      if (error instanceof NotChecked || error instanceof Failure) {
        throw error;
      }
      throw new Failure('the sign-in link did not sign in');
    }
    const needsTerms = new URL(page.url()).pathname === '/welcome';
    await page.close();
    signal.removeEventListener('abort', close);
    return { browser, context: browserContext, mailMs, needsTerms };
  } catch (error) {
    signal.removeEventListener('abort', close);
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/** Signs the probe in anew and keeps the session for the checks that use it, closing the one before. A failed sign-in keeps none. */
export async function signInFresh(context: Context, signal: AbortSignal): Promise<Session> {
  await closeSession(context);
  const opened = await signIn(context, signal);
  sessions.set(context, opened);
  return opened;
}

/** For a check that uses the session but did not open it: without one the sign-in check's failure stands for it, so this one is not checked. */
export function sessionOrNotChecked(context: Context): Session {
  const opened = sessions.get(context);
  if (!opened) {
    throw new NotChecked('the probe is not signed in, see the sign-in check');
  }
  if (opened.needsTerms) {
    throw new NotChecked('the probe must accept the account terms before these pages can be checked');
  }
  return opened;
}

export async function closeSession(context: Context): Promise<void> {
  const opened = sessions.get(context);
  sessions.delete(context);
  await opened?.browser.close().catch(() => undefined);
}
