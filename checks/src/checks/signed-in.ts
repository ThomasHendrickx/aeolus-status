import type { Page } from 'playwright';

import { loadWithAssets, PAGE_BUDGET_MS } from '../browser.ts';
import type { Context } from '../context.ts';
import { session, sessionOrNotChecked, urlOf } from '../session.ts';
import { type Check, Failure, type Outcome } from '../types.ts';

/** A signed-in check waits for the run's sign-in, which can take minutes (the mail), so its try may take longer than 30 seconds. */
const TIMEOUT_MS = 480_000;

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

function verdict(took: number, what: string): Outcome {
  return took > PAGE_BUDGET_MS ? { state: 'degraded', detail: `${what} took ${String(Math.round(took / 100) / 10)} s to load` } : { state: 'up', detail: `${what} loads` };
}

/** Account app and sign-in, 2: the probe account asks for a link, the check reads the mail and follows it to a signed-in page. A mail over 2 minutes is degraded. */
export const accountSignIn: Check<Context> = {
  name: 'Account: sign-in by mail',
  slug: 'check-account-sign-in',
  cadence: 'fifteen',
  timeoutMs: 360_000,
  async run(context) {
    const { mailMs } = await session(context);
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
  timeoutMs: TIMEOUT_MS,
  async run(context) {
    const { context: browserContext } = await sessionOrNotChecked(context);
    const page = await browserContext.newPage();
    try {
      page.setDefaultTimeout(20_000);
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
    } finally {
      await page.close();
    }
  },
};

/** Gateway and Bridge, 2: signed in, Bridge's first page loads without an error. */
export const bridge: Check<Context> = {
  name: 'Bridge: signed-in first page',
  slug: 'check-bridge',
  cadence: 'fifteen',
  timeoutMs: TIMEOUT_MS,
  async run(context) {
    const { context: browserContext } = await sessionOrNotChecked(context);
    const page = await browserContext.newPage();
    try {
      page.setDefaultTimeout(20_000);
      const took = await openSigned(page, `${urlOf(context, 'gateway')}/bridge`);
      return verdict(took, 'Bridge');
    } finally {
      await page.close();
    }
  },
};

/** Aeolus app: signed in, the home page and the fleet page load, with no error boundary, no script error and a ship shown. */
export const aeolusApp: Check<Context> = {
  name: 'Aeolus app: signed-in pages',
  slug: 'check-app',
  cadence: 'fifteen',
  timeoutMs: TIMEOUT_MS,
  async run(context) {
    const { context: browserContext } = await sessionOrNotChecked(context);
    const page = await browserContext.newPage();
    try {
      page.setDefaultTimeout(20_000);
      const app = urlOf(context, 'app');
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
      return verdict(Math.max(home, fleet), 'the app');
    } finally {
      await page.close();
    }
  },
};
