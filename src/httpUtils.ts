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

// Origin allow-list — enforcement (not just this check) is what actually
// matters; see docs/DECISIONS.md, "CORS 白名单策略".
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin.startsWith('vscode-webview://')) return true;
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return true;
  return false;
}
