// Shared HTTP request/response helpers for daemon.ts.
//
// Collapses the req.on('data')/req.on('end') body-read scaffold that used to
// be hand-rolled at every POST endpoint (~5 times), and unifies the error
// response shape — it had already drifted between `{error}` and
// `{error, code}` across handlers.

import type { IncomingMessage, ServerResponse } from 'http';

export const DAEMON_TOKEN_HEADER = 'x-ag-daemon-token';
export const DAEMON_CORS_ALLOWED_HEADERS = 'Content-Type, X-AG-Daemon-Token';

export function requiresDaemonToken(method: string | undefined, url: string | undefined): boolean {
  return method !== 'OPTIONS' && Boolean(url?.startsWith('/api/'));
}

const MAX_JSON_BODY_BYTES = 64 * 1024;
export function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_JSON_BODY_BYTES) {
        rejected = true;
        // Stop accumulating but don't destroy — the caller's catch block
        // can still write a proper 413 response on the underlying socket.
        reject(Object.assign(new Error('JSON body too large'), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (rejected) return;
      if (!body) { resolve({}); return; }
      try {
        const parsed = JSON.parse(body);
        // Block prototype pollution at the ingestion layer — individual
        // handlers no longer need their own __proto__ checks (routes.ts's
        // report-plan had one, but switch/connect/remove did not).
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const key of ['__proto__', 'constructor', 'prototype']) {
            delete parsed[key];
          }
        }
        resolve(parsed);
      } catch (e: any) {
        reject(new Error(`Invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

export function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function respondError(res: ServerResponse, status: number, error: string, code?: string): void {
  respondJson(res, status, code ? { error, code } : { error });
}

// Origin allow-list — enforcement (not just this check) is what actually
// matters; see docs/decisions/cors-allowlist-policy.md.
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin.startsWith('vscode-webview://')) return true;
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return true;
  return false;
}
