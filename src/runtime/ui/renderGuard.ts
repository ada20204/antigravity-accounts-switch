// Three small pieces of shared render/listener plumbing, each of which used to
// be independently reimplemented in both accountPopup.ts and
// settingsEnhancer.ts with no shared helper — see docs/DECISIONS.md for the
// incidents that made each one necessary in the first place.

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
// docs/DECISIONS.md) and threw away in-progress state (e.g. scroll position)
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
//
// The render-signature check above only lowers how *often* a background
// render lands mid-gesture — it does not close the bug class, since real
// quota numbers do change across a non-trivial fraction of the 20s polls in
// normal use (see docs/DECISIONS.md, code review "Altitude" finding #3). If a
// user's mousedown-to-click on Switch/Remove straddles a poll that legitimately
// has new data, the signature check no longer saves it: the element is
// rewritten between mousedown and click, and — this is the actual browser
// behaviour the original bug depended on — a target element removed from the
// document before `click` fires simply never receives that click event at
// all.
//
// This defers any render requested while a mouse button is held down until
// just after the browser would have dispatched `click` on the original,
// still-attached element. `click` fires synchronously immediately after
// `mouseup` in the same task for a real user interaction, so scheduling the
// flush from a `setTimeout(0)` inside the mouseup handler — rather than
// flushing directly inside it — lets that synchronous dispatch complete on
// the untouched DOM first.
//
// Keyed by the element the render targets, not a raw Set of closures: every
// call site passes a freshly-created closure, so closure-identity dedup was
// a no-op — two deferred requests for the same card during one held-down
// gesture just piled up as two "different" entries that both ran on flush.
// Keying by target element means a second request for the same element
// simply replaces the first (safe: each thunk reads live current data, not
// anything captured at request time), so a long gesture only ever leaves one
// real pending render per element instead of accumulating duplicates.
let pointerDown = false;
const pending = new Map<HTMLElement, () => void>();

window.addEventListener('mousedown', () => { pointerDown = true; }, true);
window.addEventListener('mouseup', () => {
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
