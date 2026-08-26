// Restarts the Antigravity backend Hub (`agy --hub`) after a shared-live account
// switch, so it picks up the newly-activated Keychain credential.
//
// Fast path: respawn the hub ourselves on the SAME port the old one used, then
// reload just the content iframes — their URLs stay valid, so VS Code never has
// to rebuild its window (~7s instead of ~30-36s). Falls back to a full window
// reload if anything about that fails. See docs/decisions/2026-08-22-same-port-respawn-optimization.md.

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { log } from './logger';

const execAsync = promisify(exec);
const CDP_BASE = 'http://127.0.0.1:9222';
const GRACEFUL_EXIT_TIMEOUT_MS = 5000;
const HUB_HEALTH_TIMEOUT_MS = 25000;
// same-port-respawn's iframe reload settles in milliseconds — the default
// grace an owned hub gets before the reaper will consider it orphaned.
const IFRAME_RELOAD_GRACE_MS = 10_000;
// Longer than IFRAME_RELOAD_GRACE_MS: the 'window' path's real settle time is
// VS Code's rebuild (20-30s), not the CDP ack — see
// docs/decisions/2026-08-23-add-account-native-signin-missing.md.
const WINDOW_RELOAD_GRACE_MS = 45_000;

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

let restartInProgress = false;

// Hubs we ourselves spawned (spawnHubOnSamePort), keyed by pid — see
// reapOrphanedHubs() below for how this is used. In-memory only, not
// persisted: a pid is only ever meaningful within the daemon run that
// recorded it, and trusting a pid recovered from a prior run risks a totally
// unrelated process having since reused that number. A daemon restart means
// this starts empty again — reapOrphanedHubs()'s unowned-pid fallback path
// is what covers hubs from before the restart, not this map.
//
// port is cached at spawn time (already known from HubSpec — no reason to
// re-derive it later via readHubPort()'s `ps` spawn on every reaper tick).
//
// graceMs starts at IFRAME_RELOAD_GRACE_MS and gets bumped to
// WINDOW_RELOAD_GRACE_MS by restartAntigravityHub() when it knows it's about
// to take the 'window' reloadStrategy path — see the grace-period comment on
// reapOrphanedHubs() for why the two paths need different windows.
const ownedHubPids = new Map<number, { spawnedAt: number; port: number; graceMs: number }>();

// Scopes findHubPids() to this window's own hub — CDP 9222 and `pgrep`
// otherwise see every window's. See
// docs/decisions/2026-08-26-extension-host-daemon.md. Empty falls back to
// unscoped rather than acting on nothing.
let ownWorkspacePaths: string[] = [];

export function setOwnWorkspacePaths(paths: string[]): void {
  ownWorkspacePaths = paths;
}

async function findAllHubPids(): Promise<number[]> {
  try {
    const { stdout } = await execAsync('pgrep -f "agy --hub"');
    return stdout.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return []; // pgrep exits 1 (no output) when nothing matches — not an error here
  }
}

async function findHubPids(): Promise<number[]> {
  const all = await findAllHubPids();
  if (ownWorkspacePaths.length === 0 || all.length <= 1) return all;

  const specs = await Promise.all(all.map(async pid => ({ pid, spec: await readHubSpec(pid) })));
  return specs
    .filter(({ spec }) => spec && spec.args.some(a => a.startsWith('--add-dir=') && ownWorkspacePaths.includes(a.slice('--add-dir='.length))))
    .map(({ pid }) => pid);
}

// Every currently-live port belonging to hubs findHubPids() considers ours —
// what cdpInjector.ts scopes its own CDP target matching against, since CDP
// itself has no per-window concept (see the comment on ownWorkspacePaths).
export async function getOwnHubPorts(): Promise<number[]> {
  const pids = await findHubPids();
  const specs = await Promise.all(pids.map(readHubSpec));
  return specs.filter((s): s is HubSpec => s !== null).map(s => s.port);
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
  ownedHubPids.set(pid, { spawnedAt: Date.now(), port: spec.port, graceMs: IFRAME_RELOAD_GRACE_MS });

  while (Date.now() - t0 < HUB_HEALTH_TIMEOUT_MS) {
    if (await probeHubHealth(spec.port)) {
      return { pid, healthyMs: Date.now() - t0 };
    }
    await sleep(150);
  }

  log('HUB_RESTART', `replacement hub pid ${pid} never became healthy within ${HUB_HEALTH_TIMEOUT_MS}ms, killing it now`);
  // Known for certain to be useless — no ambiguity to wait out, so this
  // doesn't wait for the reaper's next tick (which previously left it
  // squatting on spec.port for up to a reap cycle, risking a bind conflict
  // for whatever tries that port next).
  await terminateHub(pid, 'HUB_RESTART');
  ownedHubPids.delete(pid);
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

// SIGTERM, wait for a graceful exit, escalate to SIGKILL if it doesn't —
// shared by stopHubProcesses() (a full restart) and reapOrphanedHubs() (an
// orphan the reaper found), so a wedged process gets the same forced-kill
// treatment either way instead of the reaper settling for "sent SIGTERM,
// hope for the best" and forgetting about it regardless of whether it
// actually died.
async function terminateHub(pid: number, logTag: string): Promise<'graceful' | 'forced' | 'failed'> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e: any) {
    log(logTag, `SIGTERM failed for pid ${pid}`, e.message);
    return 'failed';
  }
  const exited = await waitForExit(pid, GRACEFUL_EXIT_TIMEOUT_MS);
  if (exited) {
    log(logTag, `pid ${pid} exited gracefully`);
    return 'graceful';
  }
  log(logTag, `pid ${pid} did not exit within ${GRACEFUL_EXIT_TIMEOUT_MS}ms, sending SIGKILL`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  return 'forced';
}

async function stopHubProcesses(): Promise<{ pids: number[]; forcedKill: number[] }> {
  const pids = await findHubPids();
  const forcedKill: number[] = [];
  for (const pid of pids) {
    log('HUB_RESTART', `sending SIGTERM to hub pid ${pid}`);
    const result = await terminateHub(pid, 'HUB_RESTART');
    if (result === 'forced') forcedKill.push(pid);
    ownedHubPids.delete(pid); // no-op if it was never ours; harmless either way
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
//
// With more than one VS Code window open there is no signal in the plain
// CDP /json listing that says which workbench target owns the hub we're
// trying to reload — targets are a flat list, iframes aren't linked back to
// their parent page here. Guessing (picking the first match) risks silently
// reloading an unrelated window while the one that actually needs it sits
// untouched. Refusing and logging is the honest answer: the caller already
// treats "target not found" as "window reload failed, hub stays down until
// reloaded manually", which is true and diagnosable, instead of quietly
// doing the wrong thing.
async function findWorkbenchPageTarget(): Promise<CdpTarget | null> {
  const targets = await listCdpTargets();
  const workbenches = targets.filter(t => t.type === 'page' && t.url.includes('workbench.html'));
  if (workbenches.length > 1) {
    log('HUB_RESTART', `${workbenches.length} VS Code windows open, cannot tell which owns this hub — refusing to guess`);
    return null;
  }
  return workbenches[0] ?? null;
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

// Swappable, vscode-API-free by design (same pattern as setOwnWorkspacePaths)
// so extension.ts could wire an alternative in without hubRestart.ts
// importing 'vscode' itself. Tried wiring workbench.action.restartExtensionHost
// here as a cheaper alternative to the CDP full window reload — reverted
// after a live test killed the extension host (and this daemon's own
// in-flight request) between the reload call returning and begin() recording
// the backup account, leaving a user signed out with no way back. See
// docs/decisions/2026-08-26-extension-host-restart-experiment.md. Nothing
// currently calls setWindowReloadFn(); this stays at the proven CDP default.
let windowReloadFn: () => Promise<boolean> = () => reloadWorkbenchWindow();
export function setWindowReloadFn(fn: () => Promise<boolean>): void {
  windowReloadFn = fn;
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

// Reaps hub processes no iframe references any more — two tiers (owned:
// precise/fast via ownedHubPids; unowned: strike-counted inference, ≥2 hubs
// required). See docs/decisions/hub-reaper-two-tier-ownership.md.
const orphanStrikes = new Map<number, number>();
const ORPHAN_STRIKES_BEFORE_REAP = 2;

async function reapOrphanedHubs(): Promise<void> {
  const pids = await findHubPids();
  if (pids.length === 0) {
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

  const now = Date.now();
  const unownedPids: number[] = [];

  for (const pid of pids) {
    const owned = ownedHubPids.get(pid);
    if (!owned) {
      unownedPids.push(pid);
      continue;
    }
    if (!isAlive(pid)) {
      ownedHubPids.delete(pid);
      continue;
    }
    if (now - owned.spawnedAt < owned.graceMs) continue;
    if (referencedPorts.has(owned.port)) continue;

    log('HUB_REAP', `reaping orphaned hub pid ${pid} (port ${owned.port}, no webview references it, spawned by us)`);
    await terminateHub(pid, 'HUB_REAP');
    ownedHubPids.delete(pid);
  }

  if (unownedPids.length < 2) {
    for (const pid of orphanStrikes.keys()) {
      if (!unownedPids.includes(pid)) orphanStrikes.delete(pid);
    }
    return;
  }

  for (const pid of unownedPids) {
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
    log('HUB_REAP', `reaping orphaned hub pid ${pid} (port ${port}, no webview references it, unowned)`);
    await terminateHub(pid, 'HUB_REAP');
  }

  for (const pid of orphanStrikes.keys()) {
    if (!unownedPids.includes(pid)) orphanStrikes.delete(pid);
  }
}

// Returns a stop function so activate() can dispose the timer on deactivate —
// see docs/decisions/2026-08-26-extension-host-daemon.md.
export function startHubReaperLoop(intervalMs = 30000): () => void {
  const timer = setInterval(() => {
    if (restartInProgress) return; // mid-restart the picture is intentionally inconsistent
    reapOrphanedHubs().catch(e => log('HUB_REAP', 'reaper tick failed', e?.message ?? String(e)));
  }, intervalMs);
  return () => clearInterval(timer);
}

export interface HubRestartResult {
  restarted: boolean;
  strategy: 'same-port-respawn' | 'window-reload' | 'none';
  detail: string;
  hubPidsStopped: number[];
  forcedKillPids: number[];
  newHubPid?: number;
  // Set when the caller's onStopped callback threw. The restart itself still
  // proceeds (see below) — this only tells the caller that whatever mutation
  // onStopped was supposed to make may not have happened, so a caller like
  // begin() (which uses onStopped to clear credentials) must not claim the
  // user is signed out without checking this first.
  onStoppedError?: string;
  // Set when a full VS Code window reload was attempted (either as the
  // 'window' reloadStrategy or the same-port-respawn-failed fallback) and
  // came back false. Distinct from onStoppedError: this means the credential
  // mutation itself may have succeeded but the caller has no live UI
  // reflecting it — begin() must treat this as a failure too, not just
  // onStoppedError, or it reports a signed-out state whose sign-in page
  // never actually appears. See docs/decisions/2026-08-23-add-account-native-signin-missing.md.
  reloadFailed?: boolean;
  timingMs: { stopHub: number; hubHealthy: number; reload: number; total: number };
}

// `onStopped` runs after every hub process has exited and before the
// replacement is spawned. Anything that mutates the credential Antigravity
// reads MUST happen in that window: a live hub writes its in-memory token back
// out as it shuts down, so clearing credentials while one is still running just
// gets silently undone. (antigravity-sync-mcp's restart worker learned the same
// thing — its auth-clear step carries the comment "在进程退出后执行，避免被
// Antigravity 写回覆盖".)
//
// A failure in onStopped does NOT abort the restart. An earlier version let it
// propagate out of the whole function — the hub was already dead by then
// (stopHubProcesses() already ran), so the caller's catch block reported "could
// not start sign-in, nothing was changed" while the hub sat there killed with
// no replacement ever spawned. Swallowing the error here and continuing to
// respawn means the hub is never left dead because of a callback failure;
// onStoppedError lets the caller still report the mutation itself as uncertain
// without lying about the hub's state.
export async function restartAntigravityHub(
  onStopped?: () => Promise<void>,
  // 'window' forces a full workbench reload instead of the fast iframe-only
  // refresh — needed by begin() so the native sign-in page appears; see
  // docs/decisions/2026-08-23-add-account-native-signin-missing.md.
  options?: { reloadStrategy?: 'iframe' | 'window' }
): Promise<HubRestartResult> {
  if (restartInProgress) {
    log('HUB_RESTART', 'restart already in progress, skipping duplicate request');
    return {
      restarted: false,
      strategy: 'none',
      detail: 'restart already in progress',
      hubPidsStopped: [],
      forcedKillPids: [],
      // The caller's onStopped never ran — a bare `undefined` here would let
      // begin() read this the same as full success. Reuses the same field
      // begin() already checks instead of adding a second, easy-to-forget one.
      onStoppedError: onStopped ? 'a restart was already in progress; onStopped was never invoked' : undefined,
      timingMs: { stopHub: 0, hubHealthy: 0, reload: 0, total: 0 },
    };
  }
  // Must check reload viability BEFORE onStopped runs, not after — see
  // docs/decisions/2026-08-26-window-reload-precheck.md.
  if (options?.reloadStrategy === 'window') {
    let target: CdpTarget | null;
    try {
      target = await findWorkbenchPageTarget();
    } catch (e: any) {
      log('HUB_RESTART', 'CDP not reachable, refusing to touch the hub before confirming a reload target', e.message);
      target = null;
    }
    if (!target) {
      log('HUB_RESTART', 'no unique workbench window to reload — refusing to touch the hub or run onStopped');
      return {
        restarted: false,
        strategy: 'none',
        detail: 'no unique VS Code window found to reload; nothing was changed',
        hubPidsStopped: [],
        forcedKillPids: [],
        reloadFailed: true,
        timingMs: { stopHub: 0, hubHealthy: 0, reload: 0, total: 0 },
      };
    }
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

    let onStoppedError: string | undefined;
    if (onStopped) {
      try {
        await onStopped();
      } catch (e: any) {
        onStoppedError = e?.message ?? String(e);
        log('HUB_RESTART', 'onStopped callback failed; restarting the hub anyway rather than leaving it dead', onStoppedError);
      }
    }

    if (spec) {
      const spawned = await spawnHubOnSamePort(spec);
      if (spawned) {
        const tHealthy = Date.now();
        let detail: string;
        let reloadFailed = false;
        if (options?.reloadStrategy === 'window') {
          // See WINDOW_RELOAD_GRACE_MS — this path's actual settle time is
          // VS Code's own rebuild, not the CDP command's ack.
          const owned = ownedHubPids.get(spawned.pid);
          if (owned) owned.graceMs = WINDOW_RELOAD_GRACE_MS;
          const windowReloaded = await windowReloadFn();
          reloadFailed = !windowReloaded;
          detail = `respawned hub on port ${spec.port} (pid ${spawned.pid}), ${windowReloaded ? 'reloaded VS Code window' : 'FAILED to reload window — extension host may still think the old hub is running'}`;
          log('HUB_RESTART', `same-port respawn OK on ${spec.port}, ${windowReloaded ? 'reloaded VS Code window' : 'window reload FAILED'}`);
        } else {
          const reloaded = await reloadIframesOnPort(spec.port);
          detail = `respawned hub on port ${spec.port} (pid ${spawned.pid}), reloaded ${reloaded} iframe(s)`;
          log('HUB_RESTART', `same-port respawn OK on ${spec.port}, reloaded ${reloaded} iframe(s)`);
        }
        const tDone = Date.now();
        return {
          restarted: true,
          strategy: 'same-port-respawn',
          detail,
          hubPidsStopped: pids,
          forcedKillPids: forcedKill,
          newHubPid: spawned.pid,
          onStoppedError,
          reloadFailed,
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
      onStoppedError,
      reloadFailed: pids.length > 0 && !windowReloaded,
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
