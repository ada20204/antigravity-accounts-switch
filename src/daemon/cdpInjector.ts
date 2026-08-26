// CDP-based UI injector — replaces the bridge.js `<script>` patch (CSP-blocked;
// see docs/decisions/cdp-injection-vs-bridge-patch.md).
//
// Event-driven, not polled: a persistent WebSocket to the browser-level CDP
// endpoint subscribes to Target.setDiscoverTargets, which delivers an
// immediate targetCreated burst for every existing target on connect and a
// targetInfoChanged event on every subsequent navigation — including a
// same-URL window.location.reload() on an existing target (verified live:
// fires ~2ms after the reload call, same targetId preserved). That covers
// both the cold-start case and the every-switch same-port-respawn iframe
// reload, which is the actual common case, not just a rare one — see
// docs/decisions/2026-08-26-event-driven-cdp-detection.md.

import { log } from './logger';
import { getOwnHubPorts } from './hubRestart';

const CDP_HTTP_BASE = 'http://127.0.0.1:9222';
const CDP_WS_BASE = 'ws://127.0.0.1:9222';
// Matches the content targets on a hub port, e.g.
// http://127.0.0.1:54408/settings-standalone?... or .../?extensionView=true
// — the port itself is checked against getOwnHubPorts() below, not this regex,
// because CDP 9222 is shared across every open VS Code window (confirmed on
// a real machine with two windows running), so without that check this would
// happily inject into a sibling window's targets too.
const TARGET_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/(settings-standalone)?\??/;

// If the discovery WebSocket ever wedges without tripping its own close/error
// handlers, this is the recovery path — not the primary detection mechanism.
const FALLBACK_POLL_MS = 5000;
const RECONNECT_DELAY_MS = 2000;
// Caps how often getOwnHubPorts() (pgrep + per-pid ps/lsof) reruns during a
// burst of events — the live test above saw 3 targetInfoChanged events for
// one reload within ~2s, and a fresh value more than twice a second buys
// nothing real (own hub ports only change right after a switch/restart).
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

async function getBrowserWsUrl(): Promise<string> {
  const res = await fetch(`${CDP_HTTP_BASE}/json/version`);
  if (!res.ok) throw new Error(`CDP /json/version returned ${res.status}`);
  const { webSocketDebuggerUrl } = await res.json();
  return webSocketDebuggerUrl;
}

// Not cached by target id — an in-place reload keeps the same id but wipes
// the injected script, so every check re-verifies idempotently instead.
async function injectInto(targetId: string, loaderSrc: string, styleSrc: string): Promise<'injected' | 'present'> {
  // CDP's per-target debugger path is /devtools/page/<id> regardless of the
  // target's own `type` (confirmed live: an "iframe"-typed target's own
  // webSocketDebuggerUrl from /json used this same path) — constructible
  // directly from the id an event already gave us, no /json re-fetch needed.
  const ws = new WebSocket(`${CDP_WS_BASE}/devtools/page/${targetId}`);

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
  });

  // Read-only DOM bootstrap: creates one <script type="module"> and one
  // <link rel="stylesheet">, both pointed at this window's own daemon port.
  // Does not touch VS Code/extension state or navigation.
  //
  // The <link> is required, not cosmetic-only: main.ts does `import
  // './ui/styles.css'`, which Vite's DEV SERVER auto-injects as a <style> tag
  // but its LIBRARY-mode production build (what runtime.js now always is)
  // instead emits it as a standalone style.css with no auto-loader.
  const expression = `
    (function() {
      if (window.AntigravityEnhancerRuntime) return 'present';
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '${styleSrc}';
      document.head.appendChild(link);
      var s = document.createElement('script');
      s.type = 'module';
      s.src = '${loaderSrc}';
      document.head.appendChild(s);
      return 'injected';
    })();
  `;

  try {
    return await new Promise<'injected' | 'present'>((resolve, reject) => {
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
export function startCdpInjectorLoop(daemonPort: number): () => void {
  const loaderSrc = `http://127.0.0.1:${daemonPort}/runtime.js`;
  const styleSrc = `http://127.0.0.1:${daemonPort}/style.css`;
  console.log('[CdpInjector] Watching for Antigravity content targets via CDP Target discovery...');

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
      const outcome = await injectInto(targetId, loaderSrc, styleSrc);
      if (outcome === 'injected') {
        // Timestamped (unlike a plain console.log) so it can be diffed
        // against [HUB_RESTART]/[SWITCH] timestamps — see
        // docs/decisions/2026-08-22-switch-timing-instrumentation.md.
        log('CDP_INJECT', 'injected into', describeTarget(url));
      }
    } catch (e) {
      console.warn(`[CdpInjector] Failed to inject into ${targetId}:`, e);
    } finally {
      inFlight.delete(targetId);
    }
  }

  async function fallbackScan(): Promise<void> {
    const ownPorts = await cachedOwnHubPorts();
    if (ownPorts.length === 0) return; // this window's hub isn't up yet
    let targets: Array<{ id: string; type: string; url: string }>;
    try {
      const res = await fetch(`${CDP_HTTP_BASE}/json`);
      if (!res.ok) return;
      targets = await res.json();
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
