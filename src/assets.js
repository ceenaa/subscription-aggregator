export const COPY_SCRIPT = `(() => {
  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall back to the older copy command when browser permissions block Clipboard API.
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('copy command failed');
  }

  for (const box of document.querySelectorAll('[data-copy-text]')) {
    const hint = box.parentElement?.querySelector('[data-copy-hint]');
    const originalHint = hint?.textContent || '';
    const run = async () => {
      try {
        await copyText(box.dataset.copyText || box.textContent || '');
        box.dataset.copied = 'true';
        if (hint) hint.textContent = 'Copied';
        window.setTimeout(() => {
          delete box.dataset.copied;
          if (hint) hint.textContent = originalHint;
        }, 1800);
      } catch {
        if (hint) hint.textContent = 'Copy failed';
      }
    };

    box.addEventListener('click', run);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        run();
      }
    });
  }
})();`;

export const INBOUNDS_SCRIPT = `${COPY_SCRIPT}
(() => {
  function randomLabel(length = 8) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  }

  for (const button of document.querySelectorAll('[data-random-email]')) {
    button.addEventListener('click', () => {
      const input = button.closest('label')?.querySelector('input[name="email"]');
      if (!input) return;
      input.value = randomLabel();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
  }
})();`;

export const CLIENTS_SCRIPT = `${COPY_SCRIPT}
(() => {
  const form = document.querySelector('[data-client-search-form]');
  const input = document.querySelector('[data-client-search-input]');
  const clearButton = document.querySelector('[data-client-search-clear]');
  const count = document.querySelector('[data-client-search-count]');
  const rows = Array.from(document.querySelectorAll('[data-client-row]'));

  function applyFilter() {
    const query = (input?.value || '').trim().toLowerCase();
    let visible = 0;

    for (const row of rows) {
      const key = row.dataset.clientSearch || '';
      const detail = row.nextElementSibling?.hasAttribute('data-panel-row')
        ? row.nextElementSibling
        : null;
      const match = !query || key.includes(query);

      row.hidden = !match;
      if (detail) detail.hidden = !match;
      if (match) visible += 1;
    }

    if (count) {
      count.textContent = visible + ' shown';
    }
  }

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
  });

  clearButton?.addEventListener('click', () => {
    if (!input) return;
    input.value = '';
    input.focus();
    applyFilter();
  });

  input?.addEventListener('input', applyFilter);

  for (const button of document.querySelectorAll('[data-edit-toggle]')) {
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => {
      const panel = button.closest('tr')?.nextElementSibling?.querySelector('[data-edit-panel]');
      if (!panel) return;
      panel.hidden = !panel.hidden;
      button.setAttribute('aria-expanded', String(!panel.hidden));
      button.textContent = panel.hidden ? 'Edit' : 'Editing';
    });
  }

  for (const button of document.querySelectorAll('[data-edit-cancel]')) {
    button.addEventListener('click', () => {
      const panel = button.closest('[data-edit-panel]');
      const toggle = panel?.closest('tr')?.previousElementSibling?.querySelector('[data-edit-toggle]');
      if (!panel) return;
      panel.hidden = true;
      if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Edit';
      }
    });
  }

  for (const checkbox of document.querySelectorAll('[data-clear-expiry]')) {
    const dateInput = checkbox.closest('form')?.querySelector('[data-expiry-date]');
    const sync = () => {
      if (!dateInput) return;
      dateInput.disabled = checkbox.checked;
      if (checkbox.checked) dateInput.value = '';
    };

    checkbox.addEventListener('change', sync);
    sync();
  }

  for (const editForm of document.querySelectorAll('[data-edit-panel]')) {
    editForm.addEventListener('submit', () => {
      const dateInput = editForm.querySelector('[data-expiry-date]');
      const timestampInput = editForm.querySelector('[data-expiry-time]');
      const clearExpiry = editForm.querySelector('[data-clear-expiry]');
      if (!dateInput || !timestampInput) return;

      timestampInput.value =
        dateInput.value && !clearExpiry?.checked
          ? String(new Date(dateInput.value).getTime())
          : '';
    });
  }

  applyFilter();
})();`;
