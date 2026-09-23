// CDP-based UI injector — replaces the bridge.js `<script>` patch (CSP-blocked;
// see docs/decisions/cdp-injection-vs-bridge-patch.md). Event-driven, not
// polled — see docs/decisions/2026-08-26-event-driven-cdp-detection.md.

import { log } from './logger';
import { getOwnHubPorts } from './hubRestart';
import { CDP_WS_BASE, getBrowserWsUrl, listCdpTargets } from './cdpClient';

const TARGET_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/(settings-standalone)?\??/;
const FALLBACK_POLL_MS = 5000;
const RECONNECT_DELAY_MS = 2000;
const OWN_PORTS_CACHE_MS = 500;

function describeTarget(url: string): string {
  const port = url.match(TARGET_URL_RE)?.[1] ?? '?';
  const view = url.includes('/settings-standalone') ? 'settings' : 'main';
  return `${view} view (port ${port})`;
}

function isOwnUrl(url: string, ownPorts: number[]): boolean {
  const match = url.match(TARGET_URL_RE);
  return !!match && ownPorts.includes(Number(match[1]));
}

// Not cached by target id — an in-place reload keeps the same id but wipes
// the injected script, so every check re-verifies idempotently instead.
async function injectInto(targetId: string, loaderSrc: string, styleSrc: string, daemonPort: number, daemonToken: string): Promise<'injected' | 'present' | 'missing'> {
  // CDP's per-target debugger path is /devtools/page/<id> regardless of the
  // target's own `type` (confirmed live: an "iframe"-typed target's own
  // webSocketDebuggerUrl from /json used this same path) — constructible
  // directly from the id an event already gave us, no /json re-fetch needed.
  const ws = new WebSocket(`${CDP_WS_BASE}/devtools/page/${targetId}`);

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
  });

  const [runtimeResponse, styleResponse] = await Promise.all([fetch(loaderSrc), fetch(styleSrc)]);
  if (!runtimeResponse.ok || !styleResponse.ok) {
    throw new Error(`runtime assets unavailable (${runtimeResponse.status}/${styleResponse.status})`);
  }
  const runtimeSource = await runtimeResponse.text();
  const styleSource = await styleResponse.text();

  // Fetch the production assets in the extension host, then evaluate the
  // JavaScript source through CDP. Appending a cross-origin <script> element
  // is still subject to the Antigravity webview CSP and can report success
  // while never executing; Runtime.evaluate is the actual injection boundary.
  // CSS is inserted as a style element for the same reason.
  const expression = `
    (function() {
      window.__AG_DAEMON_PORT__ = ${daemonPort};
      window.__AG_DAEMON_TOKEN__ = '${daemonToken}';
      if (window.AntigravitySwitchRuntime) return 'present';
      var style = document.createElement('style');
      style.textContent = ${JSON.stringify(styleSource)};
      document.head.appendChild(style);
      ${runtimeSource}
      return window.AntigravitySwitchRuntime ? 'injected' : 'missing';
    })();
  `;

  try {
    return await new Promise<'injected' | 'present' | 'missing'>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP eval timeout')), 5000);
      ws.addEventListener('message', (ev: any) => {
        const msg = JSON.parse(ev.data.toString());
        if (msg.id === 1) {
          clearTimeout(timeout);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result.result.value);
        }
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  } finally {
    ws.close();
  }
}

// daemonPort is this window's own daemon port (allocated in extension.ts's
// activate() — each window's extension host binds a different one), baked
// into the injected loader's <script src>/<link href> at check time. Returns
// a stop function so activate() can dispose everything on deactivate.
export function startCdpInjectorLoop(daemonPort: number, daemonToken: string): () => void {
  const loaderSrc = `http://127.0.0.1:${daemonPort}/runtime.js`;
  const styleSrc = `http://127.0.0.1:${daemonPort}/style.css`;
  log('CDP', 'watching for Antigravity content targets via CDP Target discovery');

  let stopped = false;
  let discoveryWs: WebSocket | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const inFlight = new Set<string>();
  let ownPortsCache: { value: number[]; at: number } | null = null;

  async function cachedOwnHubPorts(): Promise<number[]> {
    const now = Date.now();
    if (ownPortsCache && now - ownPortsCache.at < OWN_PORTS_CACHE_MS) return ownPortsCache.value;
    const value = await getOwnHubPorts();
    ownPortsCache = { value, at: now };
    return value;
  }

  // Guards against the same target being checked concurrently from two
  // sources (an event firing right as the fallback poll is also mid-check) —
  // without this both could see the runtime not yet present and both inject,
  // double-executing main.ts.
  async function checkTarget(targetId: string, url: string): Promise<void> {
    if (inFlight.has(targetId)) return;
    inFlight.add(targetId);
    try {
      const ownPorts = await cachedOwnHubPorts();
      if (!isOwnUrl(url, ownPorts)) return;
      const outcome = await injectInto(targetId, loaderSrc, styleSrc, daemonPort, daemonToken);
      if (outcome === 'missing') throw new Error('runtime evaluated but did not expose AntigravitySwitchRuntime');
      if (outcome === 'injected') {
        // Timestamped (unlike a plain console.log) so it can be diffed
        // against [HUB_RESTART]/[SWITCH] timestamps — see
        // docs/decisions/2026-08-22-switch-timing-instrumentation.md.
        log('CDP_INJECT', 'injected into', describeTarget(url));
      }
    } catch (e: any) {
      log('CDP_INJECT', `failed to inject into ${targetId}`, e?.message ?? String(e));
    } finally {
      inFlight.delete(targetId);
    }
  }

  async function fallbackScan(): Promise<void> {
    const ownPorts = await cachedOwnHubPorts();
    if (ownPorts.length === 0) return; // this window's hub isn't up yet
    let targets: Array<{ id: string; type: string; url: string }>;
    try {
      targets = await listCdpTargets();
    } catch {
      return; // VS Code not running / CDP port not open yet — retry next tick.
    }
    for (const t of targets) {
      if (t.type === 'iframe' && isOwnUrl(t.url, ownPorts)) await checkTarget(t.id, t.url);
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  }

  function connect(): void {
    if (stopped) return;
    getBrowserWsUrl().then((wsUrl) => {
      if (stopped) return;
      const ws = new WebSocket(wsUrl);
      discoveryWs = ws;
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }));
      });
      ws.addEventListener('message', (ev: any) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data.toString());
        } catch {
          return;
        }
        if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
          const info = msg.params?.targetInfo;
          if (info?.type === 'iframe') checkTarget(info.targetId, info.url);
        }
      });
      ws.addEventListener('close', scheduleReconnect);
      ws.addEventListener('error', () => ws.close());
    }).catch(() => {
      // CDP not reachable yet (VS Code not up, or 9222 not open) — retry.
      scheduleReconnect();
    });
  }

  connect();
  fallbackTimer = setInterval(() => { fallbackScan().catch(() => {}); }, FALLBACK_POLL_MS);

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (fallbackTimer) clearInterval(fallbackTimer);
    discoveryWs?.close();
  };
}
