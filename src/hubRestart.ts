// Restarts the Antigravity backend Hub (`agy --hub`) after a shared-live account
// switch, so it picks up the newly-activated Keychain credential.
//
// Fast path: respawn the hub ourselves on the SAME port the old one used, then
// reload just the content iframes — their URLs stay valid, so VS Code never has
// to rebuild its window (~7s instead of ~30-36s). Falls back to a full window
// reload if anything about that fails. See docs/DECISIONS.md, "Hub 重启".

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { log } from './logger';

const execAsync = promisify(exec);
const CDP_BASE = 'http://127.0.0.1:9222';
const GRACEFUL_EXIT_TIMEOUT_MS = 5000;
const HUB_HEALTH_TIMEOUT_MS = 25000;

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

let restartInProgress = false;

async function findHubPids(): Promise<number[]> {
  try {
    const { stdout } = await execAsync('pgrep -f "agy --hub"');
    return stdout.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return []; // pgrep exits 1 (no output) when nothing matches — not an error here
  }
}

interface HubSpec {
  bin: string;
  args: string[];
  port: number;
  cwd: string;
}

async function readHubPort(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`ps -o command= -p ${pid}`);
    const match = stdout.match(/--hub-port=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// Reads the live process's own argv and cwd rather than reconstructing them.
// The extension appends a --add-dir per workspace folder plus any configured
// serverArgs, so anything reconstructed from a fixed template would silently
// drop them and start a hub with a different view of the workspace.
async function readHubSpec(pid: number): Promise<HubSpec | null> {
  try {
    const { stdout } = await execAsync(`ps -o command= -p ${pid}`);
    const argv = stdout.trim().split(/\s+/).filter(Boolean);
    if (argv.length < 2) return null;

    const portArg = argv.find(a => a.startsWith('--hub-port='));
    const port = portArg ? Number(portArg.slice('--hub-port='.length)) : NaN;
    if (!Number.isFinite(port)) return null;

    let cwd = '';
    try {
      const { stdout: lsofOut } = await execAsync(`lsof -a -p ${pid} -d cwd -Fn`);
      const line = lsofOut.split('\n').find(l => l.startsWith('n'));
      if (line) cwd = line.slice(1).trim();
    } catch {
      // cwd only affects relative-path resolution; an empty one is survivable
    }

    return { bin: argv[0], args: argv.slice(1), port, cwd };
  } catch {
    return null;
  }
}

async function probeHubHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    clearTimeout(timer);
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

// Spawns a replacement hub on the port the old one occupied, so every already-
// open webview keeps pointing at a URL that works. Detached + unref'd so it
// outlives this daemon (restarting the daemon must not kill the user's hub).
async function spawnHubOnSamePort(spec: HubSpec): Promise<{ pid: number; healthyMs: number } | null> {
  const t0 = Date.now();
  let child;
  try {
    child = spawn(spec.bin, spec.args, {
      cwd: spec.cwd || undefined,
      env: {
        ...process.env,
        HOME: process.env.HOME ?? '',
        USERPROFILE: process.env.HOME ?? '',
        AGY_ENABLE_HUB: '1',
        ANTIGRAVITY_VSCODE_HOST: '1',
        ANTIGRAVITY_AUTH_SUCCESS_APP: 'vscode',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    child.unref();
  } catch (e: any) {
    log('HUB_RESTART', 'failed to spawn replacement hub', e.message);
    return null;
  }

  const pid = child.pid;
  if (!pid) {
    log('HUB_RESTART', 'replacement hub spawn returned no pid');
    return null;
  }
  log('HUB_RESTART', `spawned replacement hub pid ${pid} on port ${spec.port}`);

  while (Date.now() - t0 < HUB_HEALTH_TIMEOUT_MS) {
    if (await probeHubHealth(spec.port)) {
      return { pid, healthyMs: Date.now() - t0 };
    }
    await sleep(150);
  }

  log('HUB_RESTART', `replacement hub pid ${pid} never became healthy within ${HUB_HEALTH_TIMEOUT_MS}ms`);
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await sleep(200);
  }
  return !isAlive(pid);
}

async function stopHubProcesses(): Promise<{ pids: number[]; forcedKill: number[] }> {
  const pids = await findHubPids();
  const forcedKill: number[] = [];
  for (const pid of pids) {
    log('HUB_RESTART', `sending SIGTERM to hub pid ${pid}`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e: any) {
      log('HUB_RESTART', `SIGTERM failed for pid ${pid}`, e.message);
      continue;
    }
    const exited = await waitForExit(pid, GRACEFUL_EXIT_TIMEOUT_MS);
    if (!exited) {
      log('HUB_RESTART', `pid ${pid} did not exit within ${GRACEFUL_EXIT_TIMEOUT_MS}ms, sending SIGKILL`);
      try {
        process.kill(pid, 'SIGKILL');
        forcedKill.push(pid);
      } catch {
        // already gone
      }
    } else {
      log('HUB_RESTART', `pid ${pid} exited gracefully`);
    }
  }
  return { pids, forcedKill };
}

async function listCdpTargets(): Promise<CdpTarget[]> {
  const res = await fetch(`${CDP_BASE}/json`);
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`);
  return res.json();
}

// Page.reload/etc. only work on the top-level page target, not an iframe
// subtarget — this is the actual VS Code workbench window (title "Visual
// Studio Code", url starting with vscode-file://.../workbench.html).
async function findWorkbenchPageTarget(): Promise<CdpTarget | null> {
  const targets = await listCdpTargets();
  return targets.find(t => t.type === 'page' && t.url.includes('workbench.html')) ?? null;
}

async function reloadIframesOnPort(port: number): Promise<number> {
  let targets: CdpTarget[];
  try {
    targets = await listCdpTargets();
  } catch (e: any) {
    log('HUB_RESTART', 'CDP not reachable, cannot reload iframes', e.message);
    return 0;
  }

  const contentIframes = targets.filter(
    t => t.type === 'iframe' && t.url.includes(`127.0.0.1:${port}`)
  );

  let reloaded = 0;
  for (const target of contentIframes) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('CDP eval timeout')), 5000);
        ws.addEventListener('message', (ev: any) => {
          const msg = JSON.parse(ev.data.toString());
          if (msg.id === 1) {
            clearTimeout(timeout);
            resolve();
          }
        });
        // Runtime.evaluate, not Page.reload — the latter is top-level-target only.
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: 'window.location.reload(); "reloading"' },
        }));
      });
      reloaded++;
    } catch (e: any) {
      log('HUB_RESTART', `failed to reload iframe ${target.id}`, e.message);
    } finally {
      ws.close();
    }
  }
  return reloaded;
}

async function reloadWorkbenchWindow(): Promise<boolean> {
  let target: CdpTarget | null;
  try {
    target = await findWorkbenchPageTarget();
  } catch (e: any) {
    log('HUB_RESTART', 'CDP not reachable, cannot reload window', e.message);
    return false;
  }
  if (!target) {
    log('HUB_RESTART', 'workbench page target not found, cannot reload window');
    return false;
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP Page.reload timeout')), 5000);
      ws.addEventListener('message', (ev: any) => {
        const msg = JSON.parse(ev.data.toString());
        if (msg.id === 1) {
          clearTimeout(timeout);
          resolve();
        }
      });
      ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: false } }));
    });
    log('HUB_RESTART', 'reloaded VS Code window');
    return true;
  } finally {
    ws.close();
  }
}

// Reaps hub processes nothing points at any more.
//
// Two hubs can legitimately coexist (see docs/DECISIONS.md, "同端口自行 respawn"):
// ours on the original port serving the already-open webviews, plus one the
// extension spawned on a fresh port when the user opened a new panel. Neither is
// "the old one" — each serves different webviews, so killing by age would break
// whichever one still had consumers. The only safe rule is "no iframe references
// this port any more".
//
// Two guards against killing something still needed:
//  - Requires two consecutive orphan sightings. The extension spawns its hub and
//    only wires an iframe to it once waitForServerReady passes, so a single
//    snapshot can catch a brand-new hub in that gap and wrongly call it orphaned.
//  - Only ever reaps when more than one hub is running. A lone hub with no
//    iframes is just an idle backend (user closed all Antigravity panels), which
//    the extension legitimately keeps around — not our business to kill.
const orphanStrikes = new Map<number, number>();
const ORPHAN_STRIKES_BEFORE_REAP = 2;

async function reapOrphanedHubs(): Promise<void> {
  const pids = await findHubPids();
  if (pids.length < 2) {
    orphanStrikes.clear();
    return;
  }

  let targets: CdpTarget[];
  try {
    targets = await listCdpTargets();
  } catch {
    // Can't tell what's in use — assume everything is and try again next tick.
    return;
  }

  const referencedPorts = new Set<number>();
  for (const target of targets) {
    const match = target.url.match(/127\.0\.0\.1:(\d+)/);
    if (match) referencedPorts.add(Number(match[1]));
  }

  for (const pid of pids) {
    const port = await readHubPort(pid);
    if (port === null || referencedPorts.has(port)) {
      orphanStrikes.delete(pid);
      continue;
    }

    const strikes = (orphanStrikes.get(pid) ?? 0) + 1;
    if (strikes < ORPHAN_STRIKES_BEFORE_REAP) {
      orphanStrikes.set(pid, strikes);
      log('HUB_REAP', `hub pid ${pid} (port ${port}) looks orphaned (${strikes}/${ORPHAN_STRIKES_BEFORE_REAP})`);
      continue;
    }

    orphanStrikes.delete(pid);
    log('HUB_REAP', `reaping orphaned hub pid ${pid} (port ${port}, no webview references it)`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e: any) {
      log('HUB_REAP', `SIGTERM failed for pid ${pid}`, e.message);
    }
  }

  for (const pid of orphanStrikes.keys()) {
    if (!pids.includes(pid)) orphanStrikes.delete(pid);
  }
}

export function startHubReaperLoop(intervalMs = 30000): void {
  setInterval(() => {
    if (restartInProgress) return; // mid-restart the picture is intentionally inconsistent
    reapOrphanedHubs().catch(e => log('HUB_REAP', 'reaper tick failed', e?.message ?? String(e)));
  }, intervalMs);
}

export interface HubRestartResult {
  restarted: boolean;
  strategy: 'same-port-respawn' | 'window-reload' | 'none';
  detail: string;
  hubPidsStopped: number[];
  forcedKillPids: number[];
  newHubPid?: number;
  timingMs: { stopHub: number; hubHealthy: number; reload: number; total: number };
}

// `onStopped` runs after every hub process has exited and before the
// replacement is spawned. Anything that mutates the credential Antigravity
// reads MUST happen in that window: a live hub writes its in-memory token back
// out as it shuts down, so clearing credentials while one is still running just
// gets silently undone. (antigravity-sync-mcp's restart worker learned the same
// thing — its auth-clear step carries the comment "在进程退出后执行，避免被
// Antigravity 写回覆盖".)
export async function restartAntigravityHub(
  onStopped?: () => Promise<void>
): Promise<HubRestartResult> {
  if (restartInProgress) {
    log('HUB_RESTART', 'restart already in progress, skipping duplicate request');
    return {
      restarted: false,
      strategy: 'none',
      detail: 'restart already in progress',
      hubPidsStopped: [],
      forcedKillPids: [],
      timingMs: { stopHub: 0, hubHealthy: 0, reload: 0, total: 0 },
    };
  }
  restartInProgress = true;
  const t0 = Date.now();

  try {
    // Capture argv/cwd/port BEFORE killing it — they're unreadable afterwards.
    const pidsBefore = await findHubPids();
    const spec = pidsBefore.length > 0 ? await readHubSpec(pidsBefore[0]) : null;

    const { pids, forcedKill } = await stopHubProcesses();
    if (pids.length === 0) {
      log('HUB_RESTART', 'no running agy --hub process found, nothing to stop');
    }
    const tStopped = Date.now();

    if (onStopped) {
      await onStopped();
    }

    if (spec) {
      const spawned = await spawnHubOnSamePort(spec);
      if (spawned) {
        const tHealthy = Date.now();
        const reloaded = await reloadIframesOnPort(spec.port);
        const tDone = Date.now();
        log('HUB_RESTART', `same-port respawn OK on ${spec.port}, reloaded ${reloaded} iframe(s)`);
        return {
          restarted: true,
          strategy: 'same-port-respawn',
          detail: `respawned hub on port ${spec.port} (pid ${spawned.pid}), reloaded ${reloaded} iframe(s)`,
          hubPidsStopped: pids,
          forcedKillPids: forcedKill,
          newHubPid: spawned.pid,
          timingMs: {
            stopHub: tStopped - t0,
            hubHealthy: tHealthy - tStopped,
            reload: tDone - tHealthy,
            total: tDone - t0,
          },
        };
      }
      log('HUB_RESTART', 'same-port respawn failed, falling back to full window reload');
    }

    // Fallback: let VS Code rebuild everything. Much slower, but it re-resolves
    // the webview panels, which is what makes the extension spawn a hub itself.
    await sleep(300);
    const tFallbackStart = Date.now();
    const windowReloaded = await reloadWorkbenchWindow();
    const tDone = Date.now();
    return {
      restarted: pids.length > 0,
      strategy: 'window-reload',
      detail: pids.length > 0
        ? `stopped ${pids.length} hub process(es), ${windowReloaded ? 'reloaded VS Code window' : 'FAILED to reload window — hub will stay down until you reload manually'}`
        : 'no hub process was running',
      hubPidsStopped: pids,
      forcedKillPids: forcedKill,
      timingMs: {
        stopHub: tStopped - t0,
        hubHealthy: 0,
        reload: tDone - tFallbackStart,
        total: tDone - t0,
      },
    };
  } finally {
    restartInProgress = false;
  }
}
