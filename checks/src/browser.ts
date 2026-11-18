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

/** An asset failure with URL credentials, queries and suspicious path segments removed. */
export class AssetFailure extends Failure {
  constructor(failures: Map<string, string>) {
    const descriptions = [...failures].map(([raw, reason]) => {
      const url = new URL(raw);
      const sensitive = /%|@|shp_|token|secret|password|session|[A-Za-z0-9_-]{24,}/i;
      const segments = url.pathname.split('/');
      const host = url.hostname.split('.').some((label) => /[A-Za-z0-9_-]{24,}/.test(label)) ? '[redacted]' : url.host;
      const path = segments.map((segment, index) => sensitive.test(segment) || (index > 0 && /token|secret|password|session/i.test(segments[index - 1] ?? '')) ? '[redacted]' : segment).join('/');
      const address = `${url.protocol}//${host}${path}`;
      return `${address} (${reason})`;
    });
    super(`${String(failures.size)} asset${failures.size === 1 ? '' : 's'} of the page failed to load: ${descriptions.join(', ')}`);
  }
}

/**
 * Loads a page and checks rendering resources and linked icons or manifests, excluding background requests.
 * Failure details omit URL credentials and query strings. Returns the milliseconds the load took.
 */
export async function loadWithAssets(page: Page, url: string, options: { consoleTiming?: boolean; onShipTiming?: (timing: Promise<number | undefined>) => void; now?: () => number } = {}): Promise<number> {
  const failedUrls = new Map<string, string>();
  const rendering = new Set(['document', 'script', 'stylesheet', 'image', 'font']);
  page.on('response', (response) => {
    if (rendering.has(response.request().resourceType()) && response.status() >= 400) {
      failedUrls.set(response.url(), `HTTP ${String(response.status())}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (rendering.has(request.resourceType()) && !isAbortedPrefetch(request.failure()?.errorText ?? 'failed', request.url())) {
      const reason = request.failure()?.errorText ?? '';
      if (!failedUrls.has(request.url())) {
        failedUrls.set(request.url(), /^net::ERR_[A-Z_]+$/.test(reason) ? reason : 'request failed');
      }
    }
  });
  const started = Date.now();
  const now = options.now ?? Date.now;
  const timingStarted = now();
  const requests: { path: string; duration: number }[] = [];
  if (options.consoleTiming) {
    page.on('requestfinished', (request) => {
      const timing = request.timing();
      if (timing.responseEnd < 0) return;
      const segments = new URL(request.url()).pathname.split('/');
      // Only known route components are safe: even a short unknown segment can be a token.
      const safe = new Set(['', 'api', 'v1', 'fleet', 'ships', 'ship', 'whoami', 'list', '_next', 'static', 'chunks', 'css']);
      const path = segments.map((segment) => safe.has(segment) ? segment : '[redacted]').join('/');
      requests.push({ path, duration: Math.round(timing.responseEnd) });
    });
    const visibility = page.locator('[data-testid="harbour-tile"], a[href^="/ships/"]').first().waitFor({ timeout: 0 })
      .then(() => {
        const took = now() - timingStarted;
        console.log(`Console first ship visible: ${String(took)} ms`);
        return took;
      })
      .catch(() => undefined);
    options.onShipTiming?.(visibility);
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
  } catch {
    throw new Failure('the page did not load');
  }
  const took = Date.now() - started;
  if (options.consoleTiming) {
    console.log(`Console network idle: ${String(now() - timingStarted)} ms`);
    for (const request of requests.sort((a, b) => b.duration - a.duration).slice(0, 5)) {
      console.log(`Console request ${request.path}: ${String(request.duration)} ms`);
    }
  }
  const linked = await page.locator('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
  for (const icon of linked) {
    const response = await page.request.get(icon);
    if (!response.ok()) {
      failedUrls.set(icon, `HTTP ${String(response.status())}`);
    }
  }
  const failed = failedUrls.size;
  if (failed > 0) {
    throw new AssetFailure(failedUrls);
  }
  return took;
}
