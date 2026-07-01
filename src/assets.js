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

  function numberOrZero(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = numberOrZero(bytes);
    let unitIndex = 0;
    if (value <= 0) return '0 B';

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    return value.toFixed(unitIndex === 0 ? 0 : 2) + ' ' + units[unitIndex];
  }

  function quotaText(value) {
    return numberOrZero(value) > 0 ? formatBytes(value) : 'Unlimited';
  }

  function remainingText(usage) {
    return numberOrZero(usage?.total) > 0 ? formatBytes(usage?.remaining) : 'Unlimited';
  }

  function percent(used, total) {
    const parsedTotal = numberOrZero(total);
    if (!parsedTotal) return 0;
    return Math.min(Math.max((numberOrZero(used) / parsedTotal) * 100, 0), 100);
  }

  function appendCell(row, value, strong = false) {
    const cell = document.createElement('td');
    if (strong) {
      const element = document.createElement('strong');
      element.textContent = value;
      cell.appendChild(element);
    } else {
      cell.textContent = value;
    }
    row.appendChild(cell);
  }

  function renderSourceTable(sources) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    const headerRow = document.createElement('tr');
    table.className = 'panel-table';

    for (const label of [
      'Source',
      'Route',
      'Links',
      'Downloaded',
      'Uploaded',
      'Used',
      'Quota',
      'Remaining',
      'Expiry'
    ]) {
      const header = document.createElement('th');
      header.textContent = label;
      headerRow.appendChild(header);
    }

    thead.appendChild(headerRow);
    table.appendChild(thead);

    for (const source of sources || []) {
      const row = document.createElement('tr');
      appendCell(row, source.source || '', true);
      appendCell(row, source.proxy || '');
      appendCell(row, String(source.links ?? 0));
      appendCell(row, formatBytes(source.download));
      appendCell(row, formatBytes(source.upload));
      appendCell(row, formatBytes(source.used));
      appendCell(row, quotaText(source.total));
      appendCell(row, remainingText(source));
      appendCell(row, source.expiry || '');
      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    return table;
  }

  function replaceChildren(node, children) {
    while (node.firstChild) node.firstChild.remove();
    for (const child of children) node.appendChild(child);
  }

  function updateSummaryUsage(container, usage) {
    const detailRow = container.closest('[data-panel-row]');
    const clientRow = detailRow?.previousElementSibling;
    if (!clientRow?.hasAttribute('data-client-row')) return;

    const used = clientRow.querySelector('[data-client-used]');
    const total = clientRow.querySelector('[data-client-total]');
    const remaining = clientRow.querySelector('[data-client-remaining]');
    const meter = clientRow.querySelector('[data-client-meter]');

    if (used) used.textContent = formatBytes(usage?.used);
    if (total) total.textContent = quotaText(usage?.total);
    if (remaining) remaining.textContent = remainingText(usage);
    if (meter) meter.style.width = percent(usage?.used, usage?.total).toFixed(2) + '%';
  }

  function updateSummaryStatus(container, value) {
    const detailRow = container.closest('[data-panel-row]');
    const clientRow = detailRow?.previousElementSibling;
    if (!clientRow?.hasAttribute('data-client-row')) return;

    const used = clientRow.querySelector('[data-client-used]');
    const total = clientRow.querySelector('[data-client-total]');
    const remaining = clientRow.querySelector('[data-client-remaining]');
    const meter = clientRow.querySelector('[data-client-meter]');

    if (used) used.textContent = value;
    if (total) total.textContent = value;
    if (remaining) remaining.textContent = value;
    if (meter) meter.style.width = '0.00%';
  }

  async function loadSourceUsage(container) {
    if (container.dataset.loaded === 'true' || container.dataset.loading === 'true') return;

    const status = container.querySelector('[data-source-status]');
    const tableTarget = container.querySelector('[data-source-table]');
    const subId = container.dataset.subId || '';
    if (!subId || !tableTarget) return;

    container.dataset.loading = 'true';
    if (status) {
      status.hidden = false;
      status.textContent = 'Loading subscription usage...';
    }

    try {
      const response = await fetch('/clients/usage?subId=' + encodeURIComponent(subId), {
        headers: { Accept: 'application/json' }
      });
      const payload = await response.json();
      if (!response.ok || payload.error) {
        throw new Error(payload.error || 'Usage request failed');
      }

      replaceChildren(tableTarget, [renderSourceTable(payload.sources || [])]);
      updateSummaryUsage(container, payload.usage || {});
      container.dataset.loaded = 'true';
      if (status) status.hidden = true;
    } catch (error) {
      updateSummaryStatus(container, 'Unavailable');
      if (status) {
        status.hidden = false;
        status.textContent = error.message || 'Usage request failed';
      }
    } finally {
      delete container.dataset.loading;
    }
  }

  async function loadAutoSourceUsage() {
    const containers = Array.from(document.querySelectorAll('[data-source-usage][data-auto-load="true"]'));
    let nextIndex = 0;
    const concurrency = Math.min(4, containers.length);
    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIndex < containers.length) {
        const container = containers[nextIndex];
        nextIndex += 1;
        await loadSourceUsage(container);
      }
    });

    await Promise.all(workers);
  }

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

  for (const form of document.querySelectorAll('[data-confirm-action]')) {
    form.addEventListener('submit', (event) => {
      const message = form.dataset.confirmAction || 'Apply this change?';
      if (!window.confirm(message)) {
        event.preventDefault();
      }
    });
  }

  for (const editForm of document.querySelectorAll('[data-edit-panel]')) {
    const dateInput = editForm.querySelector('[data-expiry-date]');
    const expiryAfterDays = editForm.querySelector('[data-expiry-after-days]');
    const clearExpiry = editForm.querySelector('[data-clear-expiry]');

    const syncExpiryControls = (changedControl) => {
      if (!dateInput) return;

      if (changedControl === expiryAfterDays && expiryAfterDays.checked) {
        if (clearExpiry) clearExpiry.checked = false;
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const localTime = new Date(expiresAt.getTime() - expiresAt.getTimezoneOffset() * 60 * 1000);
        dateInput.value = localTime.toISOString().slice(0, 16);
        dateInput.dataset.autoExpiry = 'true';
      } else if (changedControl === expiryAfterDays && dateInput.dataset.autoExpiry === 'true') {
        dateInput.value = '';
        delete dateInput.dataset.autoExpiry;
      }

      if (changedControl === clearExpiry && clearExpiry.checked) {
        if (expiryAfterDays) expiryAfterDays.checked = false;
        dateInput.value = '';
        delete dateInput.dataset.autoExpiry;
      }

      dateInput.disabled = Boolean(clearExpiry?.checked || expiryAfterDays?.checked);
    };

    expiryAfterDays?.addEventListener('change', () => syncExpiryControls(expiryAfterDays));
    clearExpiry?.addEventListener('change', () => syncExpiryControls(clearExpiry));
    syncExpiryControls();

    editForm.addEventListener('submit', () => {
      const timestampInput = editForm.querySelector('[data-expiry-time]');
      if (!dateInput || !timestampInput) return;

      timestampInput.value =
        dateInput.value && !clearExpiry?.checked
          ? String(new Date(dateInput.value).getTime())
          : '';
    });
  }

  for (const details of document.querySelectorAll('[data-client-details]')) {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      const container = details.querySelector('[data-source-usage]');
      if (container) loadSourceUsage(container);
    });

    if (details.open) {
      const container = details.querySelector('[data-source-usage]');
      if (container) loadSourceUsage(container);
    }
  }

  window.setTimeout(loadAutoSourceUsage, 0);
  applyFilter();
})();`;
