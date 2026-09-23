// Three small pieces of shared render/listener plumbing, each of which used to
// be independently reimplemented in both accountPopup.ts and
// settingsEnhancer.ts with no shared helper — see docs/decisions/README.md for
// the incidents that made each one necessary in the first place (they're not
// all in the same entry).

// --- 1. Auto-cleanup listener binding ---
//
// Replaces two independent AbortController implementations (one stored the
// controller as a property on the DOM node, the other as a module-level
// `let`) — both existed only to fix the same real leak: a fresh popup/card
// built on every open/tab-switch left its old `window.addEventListener`
// behind forever if nothing explicitly aborted it. Measured: 5 open/close
// cycles leaked exactly 5 listeners before this existed.
const controllers = new WeakMap<HTMLElement, AbortController>();

// Binds `handler` for `event` on window, scoped to `el`'s lifetime. Rebinding
// for the same `el` replaces the previous binding (aborts it first) rather
// than stacking listeners. Returns the AbortSignal so callers that also need
// to guard an in-flight async operation (e.g. "don't render after the popup
// was closed while a fetch was pending") can reuse it instead of tracking
// their own flag.
export function bindUntilRemoved(el: HTMLElement, event: string, handler: (ev: Event) => void): AbortSignal {
  controllers.get(el)?.abort();
  const controller = new AbortController();
  controllers.set(el, controller);
  window.addEventListener(event, handler, { signal: controller.signal });
  return controller.signal;
}

export function unbind(el: HTMLElement): void {
  controllers.get(el)?.abort();
  controllers.delete(el);
}

// --- 2. Render-signature dirty check ---
//
// Replaces two independent copies of "stash a JSON signature on the element,
// skip the innerHTML rewrite if it's unchanged" (separate constant names,
// separate field lists) with one. A background poll firing on a schedule
// (every 20s) regardless of whether anything actually changed used to rewrite
// innerHTML every time, which could destroy a row mid-click (see
// docs/decisions/2026-08-23-listener-leak-unconditional-rerender.md) and threw
// away in-progress state (e.g. scroll position)
// for no reason on top of that.
const signatures = new WeakMap<HTMLElement, string>();

// Returns true if the caller should skip rendering (signature unchanged and
// not forced). Always records the new signature as a side effect, same as
// both prior implementations did, so the next call compares against it.
export function shouldSkipRender(el: HTMLElement, signature: string, force = false): boolean {
  const unchanged = !force && signatures.get(el) === signature;
  signatures.set(el, signature);
  return unchanged;
}

// --- 3. Defer rendering while a click is in flight ---
// Defers a background render requested mid-gesture until just after `click`
// would fire on the original element — see
// docs/decisions/2026-08-23-listener-leak-unconditional-rerender.md for the
// bug this closes (the render-signature check above isn't enough on its own).
// `setTimeout(0)` inside mouseup, not a direct flush, so click's synchronous
// dispatch completes on the untouched DOM first. Keyed by target element, not
// closure identity (every call site passes a fresh closure, so a Set here
// would never dedup) — a second request for the same element safely replaces
// the first instead of piling up.
let pointerDown = false;
const pending = new Map<HTMLElement, () => void>();

window.addEventListener('mousedown', () => { pointerDown = true; }, true);
window.addEventListener('mouseup', () => {
  pointerDown = false;
  setTimeout(flushPending, 0);
}, true);
// mouseup may never fire if the user drags outside the viewport, switches
// tabs, or triggers a native drag — any of which leaves pointerDown stuck
// true and all deferred renders permanently suspended. blur covers tab/
// window switches; pointercancel covers native-drag and touch interrupts.
window.addEventListener('blur', () => {
  pointerDown = false;
  setTimeout(flushPending, 0);
}, true);
window.addEventListener('pointercancel', () => {
  pointerDown = false;
  setTimeout(flushPending, 0);
}, true);

function flushPending(): void {
  // A new gesture can start before this timeout fires (two clicks landing in
  // quick succession, or the tab briefly backgrounded clamps the timer). If
  // one has, running now would replace DOM mid-gesture again — exactly the
  // bug this file exists to prevent. Bail without rescheduling: the new
  // gesture's own mouseup unconditionally calls setTimeout(flushPending, 0)
  // again regardless of whether `pending` is empty, so nothing is lost.
  if (pointerDown) return;
  const toRun = Array.from(pending.values());
  pending.clear();
  toRun.forEach(fn => fn());
}

// Runs `fn` now, unless a mouse button is currently held down, in which case
// it runs once released (after `click` has had its chance to fire). `key` is
// the element the render targets — see the Map comment above for why. Only
// meant for renders that a periodic/background trigger initiates — a render
// invoked directly from a click handler's own resolution (e.g. "reset this
// row's opacity now that the switch finished") should call its render
// function directly instead, since by then the gesture is long over.
export function renderOrDefer(key: HTMLElement, fn: () => void): void {
  if (pointerDown) {
    pending.set(key, fn);
  } else {
    fn();
  }
}

/**
 * 包装异步点击操作：提供半透明遮罩、指针防重击及键盘 Focus 隔离 (inert)，操作结束后自动恢复。
 */
export async function withActionPending<T>(element: HTMLElement, action: () => Promise<T>): Promise<T> {
  const originalOpacity = element.style.opacity;
  element.style.opacity = '0.5';
  element.style.pointerEvents = 'none';
  const hadInert = element.hasAttribute('inert');
  element.setAttribute('inert', '');
  try {
    return await action();
  } finally {
    element.style.opacity = originalOpacity;
    element.style.pointerEvents = '';
    if (!hadInert) {
      element.removeAttribute('inert');
    }
  }
}

