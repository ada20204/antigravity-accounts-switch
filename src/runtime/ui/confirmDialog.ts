// Replaces window.confirm()/alert(), which silently no-op in the VS Code
// webview sandbox — see docs/decisions/webview-confirm-alert-silent-failure.md.

import { t } from './i18n';

export interface ConfirmOptions {
  title?: string;
  okText?: string;
  cancelText?: string;
  isDanger?: boolean;
}

function buildOverlay(message: string, title?: string): { overlay: HTMLElement; actions: HTMLElement } {
  const overlay = document.createElement('div');
  overlay.className = 'ag-confirm-overlay';

  const box = document.createElement('div');
  box.className = 'ag-confirm-box';

  if (title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'ag-confirm-title';
    titleEl.textContent = title;
    box.appendChild(titleEl);
  }

  const msg = document.createElement('div');
  msg.className = 'ag-confirm-message';
  msg.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'ag-confirm-actions';

  box.appendChild(msg);
  box.appendChild(actions);
  overlay.appendChild(box);

  return { overlay, actions };
}

// Central stack for active dialogs so only the top-most modal receives Enter/Escape
interface ActiveModal {
  overlay: HTMLElement;
  handleKey: (e: KeyboardEvent) => void;
}

const activeModals: ActiveModal[] = [];

function onGlobalKeydown(e: KeyboardEvent) {
  if (activeModals.length === 0) return;
  const topModal = activeModals[activeModals.length - 1];
  topModal.handleKey(e);
}

document.addEventListener('keydown', onGlobalKeydown, true);

export function showConfirm(message: string, options?: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    const { overlay, actions } = buildOverlay(message, options?.title);

    function close(result: boolean) {
      const idx = activeModals.findIndex(m => m.overlay === overlay);
      if (idx !== -1) activeModals.splice(idx, 1);
      overlay.remove();
      resolve(result);
    }

    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
    }

    activeModals.push({ overlay, handleKey });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ag-confirm-btn ag-confirm-cancel';
    cancelBtn.textContent = options?.cancelText || t().cancel;
    cancelBtn.addEventListener('click', () => close(false));

    const okBtn = document.createElement('button');
    okBtn.className = `ag-confirm-btn ag-confirm-ok${options?.isDanger ? ' ag-confirm-danger' : ''}`;
    okBtn.textContent = options?.okText || t().ok;
    okBtn.addEventListener('click', () => close(true));

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) close(false);
    });

    document.body.appendChild(overlay);
  });
}

export function showAlert(message: string, options?: { title?: string; okText?: string }): Promise<void> {
  return new Promise(resolve => {
    const { overlay, actions } = buildOverlay(message, options?.title);

    function close() {
      const idx = activeModals.findIndex(m => m.overlay === overlay);
      if (idx !== -1) activeModals.splice(idx, 1);
      overlay.remove();
      resolve();
    }

    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        close();
      }
    }

    activeModals.push({ overlay, handleKey });

    const okBtn = document.createElement('button');
    okBtn.className = 'ag-confirm-btn ag-confirm-ok';
    okBtn.textContent = options?.okText || t().ok;
    okBtn.addEventListener('click', close);

    actions.appendChild(okBtn);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) close();
    });

    document.body.appendChild(overlay);
  });
}

