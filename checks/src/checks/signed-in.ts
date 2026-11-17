import type { Page } from 'playwright';

import { loadWithAssets, PAGE_BUDGET_MS } from '../browser.ts';
import type { Context } from '../context.ts';
import { probe } from '../fleet.ts';
import { sessionOrNotChecked, signInFresh, urlOf } from '../session.ts';
import { type Check, Failure, type Outcome } from '../types.ts';

/** The sign-in check's try: its mail may take up to 2.5 minutes (over 2 is degraded), and the page steps on each side of it 20 seconds. The checks that use the session keep the 30 seconds. */
const SIGN_IN_TIMEOUT_MS = 200_000;

const SIGN_IN_MAIL_SLOW_MS = 120_000;

/** What a page of the apps shows when it crashed or could not read the fleet: the error boundary, the fleet-not-answering notice, an alert. */
const ERROR_SHOWN_CSS = '[data-testid="page-did-not-open-try-again"], [data-testid="fleet-not-answering-status"], [data-testid="harbour-error"]';
const ERROR_SHOWN_TEXT = /This page did not open|Application error|Something went wrong/;

/** Opens a page as the probe account does and fails on a script error, an error page, or an assertion; returns how long the load took. */
async function openSigned(page: Page, url: string): Promise<number> {
  let scriptErrors = 0;
  page.on('pageerror', () => {
    scriptErrors += 1;
  });
  const took = await loadWithAssets(page, url);
  if (new URL(page.url()).pathname.startsWith('/sign-in')) {
    throw new Failure('the page asked the signed-in probe to sign in again');
  }
  if (await page.locator(ERROR_SHOWN_CSS).or(page.getByText(ERROR_SHOWN_TEXT)).first().isVisible()) {
    throw new Failure('the page shows an error');
  }
  if (scriptErrors > 0) {
    throw new Failure(`the page raised ${String(scriptErrors)} script error${scriptErrors === 1 ? '' : 's'}`);
  }
  return took;
}

async function shipsShown(page: Page): Promise<void> {
  try {
    await page.locator('[data-testid="harbour-tile"], a[href^="/ships/"]').first().waitFor({ timeout: 10_000 });
  } catch {
    throw new Failure('the page shows no ship');
  }
}

/** A fresh page in the run's signed-in session, closed when the check ends or its time is up. */
async function inSession<T>(context: Context, signal: AbortSignal, run: (page: Page) => Promise<T>): Promise<T> {
  const page = await sessionOrNotChecked(context).context.newPage();
  const close = (): void => void page.close().catch(() => undefined);
  signal.addEventListener('abort', close);
  try {
    page.setDefaultTimeout(20_000);
    return await run(page);
  } finally {
    signal.removeEventListener('abort', close);
    await page.close().catch(() => undefined);
  }
}

function verdict(took: number, what: string): Outcome {
  return took > PAGE_BUDGET_MS ? { state: 'degraded', detail: `${what} took ${String(Math.round(took / 100) / 10)} s to load` } : { state: 'up', detail: `${what} loads` };
}

/** Account app and sign-in, 2: the probe account asks for a link, the check reads the mail and follows it to a signed-in page. A mail over 2 minutes is degraded. */
export const accountSignIn: Check<Context> = {
  name: 'Account: sign-in by mail',
  slug: 'check-account-sign-in',
  cadence: 'fifteen',
  timeoutMs: SIGN_IN_TIMEOUT_MS,
  session: 'opens',
  async run(context, signal) {
    const { mailMs } = await signInFresh(context, signal);
    return mailMs > SIGN_IN_MAIL_SLOW_MS
      ? { state: 'degraded', detail: `the sign-in mail took ${String(Math.round(mailMs / 6_000) / 10)} minutes` }
      : { state: 'up', detail: 'a sign-in link mailed and followed to a signed-in page' };
  },
};

/** Console: signed in as the probe account, the console's overview loads with its assets and shows the fleet's ships, as Open in console from the account app leads to it. */
export const consoleOverview: Check<Context> = {
  name: 'Console: signed-in overview',
  slug: 'check-console',
  cadence: 'fifteen',
  session: 'uses',
  run: (context, signal) => inSession(context, signal, async (page) => {
    try {
      await page.goto(`${urlOf(context, 'account')}/organisation/fleets`);
      await page.getByRole('button', { name: 'Open in console' }).click();
      await page.waitForURL((url) => url.pathname === '/' && url.origin !== new URL(urlOf(context, 'account')).origin);
    } catch {
      throw new Failure('the account app did not open the console');
    }
    const took = await openSigned(page, page.url());
    await shipsShown(page);
    return verdict(took, 'the console');
  }),
};

/** Gateway and Bridge, 2: signed in, Bridge's first page loads without an error. */
export const bridge: Check<Context> = {
  name: 'Bridge: signed-in first page',
  slug: 'check-bridge',
  cadence: 'fifteen',
  session: 'uses',
  run: (context, signal) => inSession(context, signal, async (page) => verdict(await openSigned(page, `${urlOf(context, 'gateway')}/bridge`), 'Bridge')),
};

/** Aeolus app: signed in, the home page, the fleet page and the probe's own ship's page load, with no error boundary and no script error, and the probe's own ship shown. */
export const aeolusApp: Check<Context> = {
  name: 'Aeolus app: signed-in pages',
  slug: 'check-app',
  cadence: 'fifteen',
  session: 'uses',
  run: (context, signal) => inSession(context, signal, async (page) => {
    const app = urlOf(context, 'app');
    const me = (await probe(context, signal).call('GET', '/ship/whoami')) as { shipId?: string; name?: string };
    if (!me.shipId || !me.name) {
      throw new Failure('the probe could not be identified');
    }
    try {
      await page.goto(`${app}/sign-in/start`);
      await page.getByTestId('sign-in-continue').click();
      await page.waitForURL((url) => url.origin === new URL(app).origin && !url.pathname.startsWith('/sign-in'));
    } catch {
      throw new Failure('the app did not sign the probe in');
    }
    const home = await openSigned(page, `${app}/`);
    const fleet = await openSigned(page, `${app}/fleet`);
    await shipsShown(page);
    if (!(await page.getByTestId('harbour-tile').filter({ hasText: me.name }).first().isVisible())) {
      throw new Failure('the page does not show the probe\'s own ship');
    }
    const shipUrl = new URL(`/conversations/${encodeURIComponent(me.shipId)}`, page.url());
    shipUrl.search = new URL(page.url()).search;
    shipUrl.searchParams.set('name', me.name);
    const ship = await openSigned(page, shipUrl.toString());
    if (!(await page.getByText(me.name).first().isVisible())) {
      throw new Failure('the ship page does not show the ship');
    }
    return verdict(Math.max(home, fleet, ship), 'the app');
  }),
};
