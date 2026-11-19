import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

/** Fleet transport. Log only timings, never the URL, headers, or bodies. */
export const fleetFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const secure = url.protocol === 'https:';
  const paths = ['/fleet/list', '/ship/whoami', '/ship/send', '/ship/receive', '/ship/ack'];
  const path = paths.find((item) => url.pathname.endsWith(`/api/v1${item}`)) ?? 'other';
  if (!secure && url.protocol !== 'http:') throw new TypeError('unsupported protocol');
  const started = performance.now();
  let dns: number | undefined;
  let connect: number | undefined;
  let tls: number | undefined;
  let ttfb: number | undefined;
  let reused = false;
  const ms = (value: number | undefined): string => value === undefined ? 'n/a' : `${String(Math.round(value))}ms`;
  try {
    return await new Promise<Response>((resolve, reject) => {
      const request = (secure ? https : http).request(url, {
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)),
        agent: secure ? httpsAgent : httpAgent,
        signal: init?.signal ?? undefined,
      }, (response) => {
        ttfb = performance.now() - started;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: response.headers as Record<string, string> }));
        });
      });
      request.on('socket', (socket: Socket) => {
        reused = request.reusedSocket;
        if (reused) return;
        let phase = performance.now();
        socket.once('lookup', () => { const now = performance.now(); dns = now - phase; phase = now; });
        socket.once('connect', () => { const now = performance.now(); connect = now - phase; phase = now; });
        if (secure) (socket as TLSSocket).once('secureConnect', () => { tls = performance.now() - phase; });
      });
      request.on('error', reject);
      request.end(init?.body as string | undefined);
    });
  } finally {
    console.log(`Fleet call ${path} dns=${ms(dns)} connect=${ms(connect)} tls=${ms(tls)} ttfb=${ms(ttfb)} reused=${String(reused)}`);
  }
};
