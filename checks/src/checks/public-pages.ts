import { loadWithAssets, PAGE_BUDGET_MS, withPage } from '../browser.ts';
import type { Context } from '../context.ts';
import { type Check, Failure } from '../types.ts';

/** A page that loads with its assets in a browser: up, degraded when it took over 5 s. */
export function pageLoads(name: string, slug: string, cadence: Check<Context>['cadence'], url: (context: Context) => string, what: string): Check<Context> {
  return {
    name,
    slug,
    cadence,
    run: (context, signal) => withPage(signal, async (page) => {
      const took = await loadWithAssets(page, url(context));
      return took > PAGE_BUDGET_MS ? { state: 'degraded', detail: `${what} took ${String(Math.round(took / 100) / 10)} s to load` } : { state: 'up', detail: `${what} loads` };
    }),
  };
}

const ACCOUNT = 'https://account.aeolus-fleet.dev';
const SITE = 'https://aeolus-fleet.dev';
const SITE_COM = 'https://aeolus-fleet.com';

/** Account app and sign-in, 1: the sign-in page loads with its assets. */
export const accountPage = pageLoads('Account: sign-in page', 'check-account-page', 'five', (context) => context.env.ACCOUNT_URL ?? ACCOUNT, 'the sign-in page');

/** Site: the one-pager loads, on .dev and on .com. */
export const siteDev = pageLoads('Site (.dev)', 'check-site-dev', 'fifteen', (context) => context.env.SITE_URL ?? SITE, 'the site');
export const siteCom = pageLoads('Site (.com)', 'check-site-com', 'fifteen', (context) => context.env.SITE_COM_URL ?? SITE_COM, 'the site');

/** Gateway and Bridge, 1: the OAuth discovery document answers JSON with its issuer, and /mcp answers 401 with its WWW-Authenticate. */
export const gatewayHttp: Check<Context> = {
  name: 'Gateway: OAuth discovery and MCP endpoint',
  slug: 'check-gateway',
  cadence: 'fifteen',
  async run(context, signal) {
    const base = context.env.GATEWAY_URL ?? 'https://gateway.aeolus-fleet.dev';
    const started = context.now();
    const discovery = await context.fetch(`${base}/.well-known/oauth-authorization-server`, { signal });
    if (!discovery.ok) {
      throw new Failure(`the OAuth discovery document answered ${String(discovery.status)}`);
    }
    const document = (await discovery.json().catch(() => null)) as { issuer?: unknown } | null;
    if (typeof document?.issuer !== 'string' || document.issuer !== base) {
      throw new Failure('the OAuth discovery document has no valid issuer');
    }
    const mcp = await context.fetch(`${base}/mcp`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: '{}' });
    if (mcp.status !== 401 || !mcp.headers.get('www-authenticate')?.startsWith('Bearer')) {
      throw new Failure(`the MCP endpoint answered ${String(mcp.status)} to an unauthenticated call, not 401 with its challenge`);
    }
    const took = context.now() - started;
    return took > PAGE_BUDGET_MS ? { state: 'degraded', detail: `the gateway took ${String(Math.round(took / 100) / 10)} s to answer` } : { state: 'up', detail: 'the gateway discovery and MCP endpoint answer' };
  },
};
