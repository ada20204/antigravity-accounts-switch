// Shared HTTP request/response helpers for daemon.ts.
//
// Collapses the req.on('data')/req.on('end') body-read scaffold that used to
// be hand-rolled at every POST endpoint (~5 times), and unifies the error
// response shape — it had already drifted between `{error}` and
// `{error, code}` across handlers.

import type { IncomingMessage, ServerResponse } from 'http';

export function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try {
        resolve(JSON.parse(body));
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

// Origin allow-list, not '*' — see docs/DECISIONS.md, "CORS 白名单策略".
//
// Enforcement matters as much as the allow-list itself: setting
// Access-Control-Allow-Origin only controls whether a browser lets the calling
// page's JS *read* the response. It does nothing to stop the request from
// being *sent* and executed server-side in the first place — a same-origin
// "simple" request (no custom Content-Type, no body, which several of this
// daemon's own endpoints are) never triggers a CORS preflight at all, so a
// page from any origin can already have caused the side effect before any
// browser-side check would even run. The actual defense has to be server-side:
// reject outright when a browser-supplied Origin header doesn't match. A
// missing Origin header (curl, our own Terminal script) is treated as trusted
// local access — a page in a browser tab always sends Origin on a cross-origin
// fetch/XHR, preflighted or not, so its absence is not something a malicious
// web page can forge from a plain fetch() call.
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin.startsWith('vscode-webview://')) return true;
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return true;
  return false;
}
