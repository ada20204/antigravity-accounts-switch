// Centralized Chrome DevTools Protocol (CDP) client helpers.
// Shared by cdpInjector.ts (UI script injection) and hubRestart.ts (hub target discovery & reload).

export const CDP_HTTP_BASE = 'http://127.0.0.1:9222';
export const CDP_WS_BASE = 'ws://127.0.0.1:9222';

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  description?: string;
  devtoolsFrontendUrl?: string;
  webSocketDebuggerUrl?: string;
}

export async function listCdpTargets(): Promise<CdpTarget[]> {
  const res = await fetch(`${CDP_HTTP_BASE}/json`);
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`);
  return await res.json();
}

export async function getBrowserWsUrl(): Promise<string> {
  const res = await fetch(`${CDP_HTTP_BASE}/json/version`);
  if (!res.ok) throw new Error(`CDP /json/version returned ${res.status}`);
  const { webSocketDebuggerUrl } = await res.json();
  return webSocketDebuggerUrl;
}
