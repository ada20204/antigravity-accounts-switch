// CDP-based UI injector — replaces the bridge.js `<script>` patch (CSP-blocked;
// see docs/decisions/cdp-injection-vs-bridge-patch.md).

import { log } from './logger';

const CDP_BASE = 'http://127.0.0.1:9222';
const LOADER_SRC = 'http://localhost:5173/src/runtime/main.ts';
// Matches the content iframes on the ephemeral hub port, e.g.
// http://127.0.0.1:54408/settings-standalone?... or .../?extensionView=true
const TARGET_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/(settings-standalone)?\??/;

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function listTargets(): Promise<CdpTarget[]> {
  const res = await fetch(`${CDP_BASE}/json`);
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`);
  return res.json();
}

function isContentTarget(t: CdpTarget): boolean {
  return t.type === 'iframe' && TARGET_URL_RE.test(t.url);
}

// Not cached by target id — an in-place iframe reload keeps the same id but
// wipes the injected script, so every tick re-checks idempotently instead.
async function injectInto(target: CdpTarget): Promise<'injected' | 'present'> {
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
  });

  // Read-only DOM bootstrap: creates one <script type="module"> pointed at our
  // own Vite dev server. Does not touch VS Code/extension state or navigation.
  const expression = `
    (function() {
      if (window.AntigravityEnhancerRuntime) return 'present';
      var s = document.createElement('script');
      s.type = 'module';
      s.src = '${LOADER_SRC}';
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

export function startCdpInjectorLoop(intervalMs = 2000): void {
  console.log('[CdpInjector] Watching for Antigravity content iframes via CDP...');

  setInterval(async () => {
    let targets: CdpTarget[];
    try {
      targets = await listTargets();
    } catch {
      // VS Code not running / CDP port not open yet — retry next tick.
      return;
    }

    for (const t of targets.filter(isContentTarget)) {
      try {
        const outcome = await injectInto(t);
        if (outcome === 'injected') {
          // Timestamped (unlike a plain console.log) so it can be diffed
          // against [HUB_RESTART]/[SWITCH] timestamps to see how long a
          // fresh iframe took to appear and accept injection after a
          // window reload — see docs/decisions/2026-08-22-switch-timing-instrumentation.md.
          log('CDP_INJECT', 'injected into', t.url);
        }
      } catch (e) {
        console.warn(`[CdpInjector] Failed to inject into ${t.id}:`, e);
      }
    }
  }, intervalMs);
}
