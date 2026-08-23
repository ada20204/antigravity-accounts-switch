// Replaces window.confirm()/alert(), which silently no-op in the VS Code
// webview sandbox — see docs/DECISIONS.md, "confirm()/alert() 静默失效".

function buildOverlay(message: string): { overlay: HTMLElement; actions: HTMLElement } {
  const overlay = document.createElement('div');
  overlay.className = 'ag-confirm-overlay';

  const box = document.createElement('div');
  box.className = 'ag-confirm-box';

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

export function showConfirm(message: string): Promise<boolean> {
  return new Promise(resolve => {
    const { overlay, actions } = buildOverlay(message);

    function close(result: boolean) {
      overlay.remove();
      resolve(result);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ag-confirm-btn ag-confirm-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => close(false));

    const okBtn = document.createElement('button');
    okBtn.className = 'ag-confirm-btn ag-confirm-ok';
    okBtn.textContent = 'Continue';
    okBtn.addEventListener('click', () => close(true));

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) close(false);
    });

    document.body.appendChild(overlay);
  });
}

export function showAlert(message: string): Promise<void> {
  return new Promise(resolve => {
    const { overlay, actions } = buildOverlay(message);

    function close() {
      overlay.remove();
      resolve();
    }

    const okBtn = document.createElement('button');
    okBtn.className = 'ag-confirm-btn ag-confirm-ok';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', close);

    actions.appendChild(okBtn);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) close();
    });

    document.body.appendChild(overlay);
  });
}
