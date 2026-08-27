// Covers the gap between "switch accepted" and "Antigravity finished
// reloading" (~7s, see docs/FLOWS.md's switch flow and
// docs/decisions/2026-08-22-same-port-respawn-optimization.md). On success
// nobody closes this — the iframe reload wipes it, which is the completion
// signal. The timeout only exists so a failed restart doesn't leave a
// permanent modal behind.

export interface ProgressHandle {
  close(): void;
}

export function showProgress(title: string, detail?: string, timeoutMs = 30000): ProgressHandle {
  const overlay = document.createElement('div');
  overlay.className = 'ag-progress-overlay';

  const box = document.createElement('div');
  box.className = 'ag-progress-box';

  const spinner = document.createElement('div');
  spinner.className = 'ag-progress-spinner';

  const text = document.createElement('div');
  const titleEl = document.createElement('div');
  titleEl.className = 'ag-progress-title';
  titleEl.textContent = title;
  text.appendChild(titleEl);

  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.className = 'ag-progress-detail';
    detailEl.textContent = detail;
    text.appendChild(detailEl);
  }

  box.appendChild(spinner);
  box.appendChild(text);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    overlay.remove();
  };

  const timer = setTimeout(() => {
    titleEl.textContent = 'Still working…';
    const stuck = document.createElement('div');
    stuck.className = 'ag-progress-detail';
    stuck.textContent = 'Antigravity has not reloaded yet. If nothing happens, reload the window manually.';
    text.appendChild(stuck);
    setTimeout(close, 6000);
  }, timeoutMs);

  return { close };
}
