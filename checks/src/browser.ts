import { chromium, type Page } from 'playwright';

import { Failure } from './types.ts';

export const PAGE_BUDGET_MS = 5_000;
const LOAD_TIMEOUT_MS = 20_000;

/** One browser run for a check: a fresh page, closed when the check ends or its time is up. */
export async function withPage<T>(signal: AbortSignal, run: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  const close = (): void => void browser.close().catch(() => undefined);
  signal.addEventListener('abort', close);
  try {
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(LOAD_TIMEOUT_MS);
    return await run(page);
  } finally {
    signal.removeEventListener('abort', close);
    await browser.close().catch(() => undefined);
  }
}

/** A prefetch the page started and the browser aborted (an RSC prefetch, `?_rsc=`) is not a failed load. */
function isAbortedPrefetch(errorText: string, url: string): boolean {
  return errorText === 'net::ERR_ABORTED' && new URL(url).searchParams.has('_rsc');
}

/**
 * Loads a page as a person does and fails when any request failed or answered 400 or more, or an icon or manifest it links is not served.
 * The failure says how many, never which: the repository is public. Returns the milliseconds the load took.
 */
export async function loadWithAssets(page: Page, url: string): Promise<number> {
  const failedUrls = new Set<string>();
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedUrls.add(response.url());
    }
  });
  page.on('requestfailed', (request) => {
    if (!isAbortedPrefetch(request.failure()?.errorText ?? 'failed', request.url())) {
      failedUrls.add(request.url());
    }
  });
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
  } catch {
    throw new Failure('the page did not load');
  }
  const took = Date.now() - started;
  const linked = await page.locator('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
  for (const icon of linked) {
    if (!(await page.request.get(icon)).ok()) {
      failedUrls.add(icon);
    }
  }
  const failed = failedUrls.size;
  if (failed > 0) {
    throw new Failure(`${String(failed)} asset${failed === 1 ? '' : 's'} of the page failed to load`);
  }
  return took;
}
