// Covers the gap between "switch accepted" and "Antigravity finished
// reloading". The daemon answers /api/switch in ~150ms (deliberately, so the
// reply isn't cut off by the reload it triggers) but the hub respawn plus
// iframe reload takes ~7s after that. Without this the user confirms, sees
// nothing happen, and then the whole panel blanks and reloads unannounced.
//
// On success nobody closes this: the iframe reload wipes it, which is exactly
// the moment the new account is actually live. The timeout only exists so a
// failed restart can't leave a permanent modal behind.

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
