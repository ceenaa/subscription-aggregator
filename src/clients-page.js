import { formatBytes } from './usage.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function percent(used, total) {
  if (!total) return 0;
  return Math.min(Math.max((used / total) * 100, 0), 100);
}

function quotaText(value) {
  return value > 0 ? formatBytes(value) : 'Unlimited';
}

function remainingText(usage) {
  return usage.total > 0 ? formatBytes(usage.remaining) : 'Unlimited';
}

function statusClass(status) {
  return status.toLowerCase();
}

function editForm(client) {
  return `
    <form class="edit-form" method="post" action="/clients/edit" data-edit-panel hidden>
      <input type="hidden" name="subId" value="${escapeHtml(client.subId)}">
      <div class="edit-heading">
        <div>
          <strong>Edit configuration</strong>
          <span>${escapeHtml(client.email || client.subId)}</span>
        </div>
        <button type="button" class="ghost-button" data-edit-cancel>Close</button>
      </div>
      <div class="edit-fields">
        <label>
          <span>Status</span>
          <select name="status">
            <option value="">Keep current</option>
            <option value="enable">Enable</option>
            <option value="disable">Disable</option>
          </select>
        </label>
        <label>
          <span>Add Usage (GB)</span>
          <div class="input-suffix">
            <input type="number" name="addGB" min="0" step="0.01" inputmode="decimal" placeholder="0.00">
            <span>GB</span>
          </div>
        </label>
        <label class="expiry-field">
          <span>Expiry Date</span>
          <input type="datetime-local" name="expiryDate" data-expiry-date>
          <input type="hidden" name="expiryTime" data-expiry-time>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" name="clearExpiry" value="true" data-clear-expiry>
          <span>No expiry</span>
        </label>
      </div>
      <div class="edit-actions">
        <button type="submit" class="primary-button">Save changes</button>
      </div>
    </form>
  `;
}

function quickExpiryForm(client) {
  const clientLabel = client.email || client.subId;

  return `
    <form
      class="quick-expiry-form"
      method="post"
      action="/clients/edit"
      data-confirm-action="Set ${escapeHtml(clientLabel)} expiry to 30 days from now?"
    >
      <input type="hidden" name="subId" value="${escapeHtml(client.subId)}">
      <input type="hidden" name="expiryAfterDays" value="30">
      <button
        type="submit"
        class="quick-expiry-button"
        title="Set expiry to 30 days from now"
        aria-label="Set ${escapeHtml(clientLabel)} expiry to 30 days from now"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M8 2v3"></path>
          <path d="M16 2v3"></path>
          <path d="M3.5 9h17"></path>
          <path d="M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"></path>
          <path d="M12 13v3l2 1"></path>
        </svg>
      </button>
    </form>
  `;
}

function panelRows(client) {
  return client.panels
    .map(
      (panel) => `
        <tr>
          <td>
            <strong>${escapeHtml(panel.panel)}</strong>
            <span>${escapeHtml(panel.proxy)} route</span>
          </td>
          <td>${escapeHtml(panel.enabled ? 'Active' : 'Inactive')}</td>
          <td>${escapeHtml(panel.quotaDivisor)}</td>
          <td>${escapeHtml(panel.email)}</td>
        </tr>
      `
    )
    .join('');
}

function sourceTable(sources) {
  return `
    <table class="panel-table">
      <thead>
        <tr>
          <th>Source</th>
          <th>Route</th>
          <th>Links</th>
          <th>Downloaded</th>
          <th>Uploaded</th>
          <th>Used</th>
          <th>Quota</th>
          <th>Remaining</th>
          <th>Expiry</th>
        </tr>
      </thead>
      <tbody>
        ${sources
          .map(
            (source) => `
              <tr>
                <td><strong>${escapeHtml(source.source)}</strong></td>
                <td>${escapeHtml(source.proxy)}</td>
                <td>${escapeHtml(source.links)}</td>
                <td>${formatBytes(source.download)}</td>
                <td>${formatBytes(source.upload)}</td>
                <td>${formatBytes(source.used)}</td>
                <td>${quotaText(source.total)}</td>
                <td>${remainingText(source)}</td>
                <td>${escapeHtml(source.expiry)}</td>
              </tr>
            `
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function sourceRows(client) {
  const hasSources = client.sources?.length > 0;
  if (!hasSources && !client.canLoadSubscriptionUsage) return '';

  return `
    <section
      class="source-usage"
      data-source-usage
      data-sub-id="${escapeHtml(client.subId)}"
      ${hasSources ? 'data-loaded="true"' : ''}
      ${client.autoLoadSubscriptionUsage ? 'data-auto-load="true"' : ''}
    >
      <h3>Subscription Usage</h3>
      <div class="source-status" data-source-status ${hasSources ? 'hidden' : ''}>Loading subscription usage...</div>
      <div data-source-table>${hasSources ? sourceTable(client.sources) : ''}</div>
    </section>
  `;
}

function clientRows(clients) {
  if (clients.length === 0) {
    return `
      <tr>
        <td colspan="7" class="empty">No clients exist in every configured panel inbound.</td>
      </tr>
    `;
  }

  return clients
    .map((client) => {
      const usage = client.usage;
      const isLoadingUsage = client.autoLoadSubscriptionUsage && !client.sources?.length;
      const meterWidth = isLoadingUsage ? '0.00' : percent(usage.used, usage.total).toFixed(2);
      const usedText = isLoadingUsage ? 'Loading...' : formatBytes(usage.used);
      const totalText = isLoadingUsage ? 'Loading...' : quotaText(usage.total);
      const remainingValue = isLoadingUsage ? 'Loading...' : remainingText(usage);
      const searchText = `${client.email || ''} ${client.subId}`.toLowerCase();

      return `
        <tr class="client-row" data-client-row data-client-search="${escapeHtml(searchText)}">
          <td>
            <strong>${escapeHtml(client.email || client.subId)}</strong>
            <span>${escapeHtml(client.subId)}</span>
          </td>
          <td><span class="status ${statusClass(client.status)}">${escapeHtml(client.status)}</span></td>
          <td data-client-used>${escapeHtml(usedText)}</td>
          <td data-client-total>${escapeHtml(totalText)}</td>
          <td data-client-remaining>${escapeHtml(remainingValue)}</td>
          <td>
            <div class="meter" aria-label="Normalized usage">
              <span data-client-meter style="width: ${meterWidth}%"></span>
            </div>
          </td>
          <td>
            <div class="client-actions">
              <a href="${escapeHtml(client.subscriptionUrl)}">Open</a>
              <button type="button" data-copy-text="${escapeHtml(client.subscriptionUrl)}">Copy</button>
              ${quickExpiryForm(client)}
              <button type="button" data-edit-toggle>Edit</button>
            </div>
          </td>
        </tr>
        <tr class="panel-row" data-panel-row>
          <td colspan="7">
            ${editForm(client)}
            <details data-client-details>
              <summary>${client.enabledPanels}/${client.totalPanels} panels active</summary>
              ${client.usageError ? `<p class="usage-error">${escapeHtml(client.usageError)}</p>` : ''}
              ${sourceRows(client)}
              <h3>Panel Status</h3>
              <table class="panel-table">
                <thead>
                  <tr>
                    <th>Panel</th>
                    <th>Status</th>
                    <th>Divisor</th>
                    <th>Email</th>
                  </tr>
                </thead>
                <tbody>${panelRows(client)}</tbody>
              </table>
            </details>
          </td>
        </tr>
      `;
    })
    .join('');
}

function panelSummary(panels) {
  return panels
    .map(
      (panel) => `
        <li>
          <strong>${escapeHtml(panel.name)}</strong>
          <span>Inbound ${escapeHtml(panel.inboundId)}</span>
          <span>${escapeHtml(panel.proxy)}</span>
          <span>divisor ${escapeHtml(panel.quotaDivisor)}</span>
        </li>
      `
    )
    .join('');
}

function updateResultList(results) {
  if (!results?.length) return '';

  return `
    <ul class="update-results">
      ${results
        .map(
          (result) => `
            <li class="${result.ok ? 'ok' : 'fail'}">
              <strong>${escapeHtml(result.panel)}</strong>
              <span>${escapeHtml(result.skipped ? 'No changes' : result.response || result.error || '')}</span>
            </li>
          `
        )
        .join('')}
    </ul>
  `;
}

export function renderClientsPage({
  clients = [],
  panels = [],
  error = '',
  message = '',
  updateResults = [],
  updatedAt = new Date()
}) {
  const updatedDate = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  const updatedLabel = Number.isNaN(updatedDate.getTime())
    ? 'Unknown'
    : updatedDate.toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'medium'
      });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Created Configurations</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: #0f1a2b;
      --line: #2a3952;
      --line-soft: rgba(154, 168, 189, 0.22);
      --text: #eef3fb;
      --muted: #9aa8bd;
      --accent: #2dd4bf;
      --warning: #fbbf24;
      --danger: #fb7185;
      --ok: #86efac;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 30px 0 48px;
    }

    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: end;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }

    h1, p {
      margin: 0;
    }

    h3 {
      margin: 14px 0 8px;
      color: var(--text);
      font-size: 13px;
      line-height: 1.2;
    }

    h1 {
      font-size: clamp(28px, 4vw, 40px);
      line-height: 1.05;
    }

    header p {
      margin-top: 8px;
      color: var(--muted);
      font-size: 14px;
    }

    nav {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    a,
    button {
      color: #99f6e4;
      font: inherit;
      font-weight: 750;
    }

    nav a,
    .client-row a,
    .client-row button {
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 7px 11px;
      border: 1px solid rgba(45, 212, 191, 0.55);
      border-radius: 8px;
      background: rgba(20, 184, 166, 0.1);
      text-decoration: none;
    }

    button {
      cursor: pointer;
    }

    .client-row button {
      margin: 0;
    }

    .client-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      max-width: 260px;
      white-space: normal;
    }

    .client-actions > a,
    .client-actions > button,
    .client-actions > form {
      flex: 0 0 auto;
      white-space: nowrap;
    }

    .quick-expiry-form {
      display: inline-flex;
      margin: 0;
    }

    .quick-expiry-button {
      width: 36px;
      padding: 7px;
    }

    .quick-expiry-button svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 2;
    }

    [data-copy-text][data-copied="true"] {
      border-color: rgba(134, 239, 172, 0.85);
      color: var(--ok);
    }

    .error {
      margin-top: 18px;
      padding: 12px 14px;
      border: 1px solid rgba(251, 113, 133, 0.45);
      border-radius: 8px;
      color: #fecdd3;
      background: rgba(127, 29, 29, 0.28);
    }

    .message {
      margin-top: 18px;
      padding: 12px 14px;
      border: 1px solid rgba(45, 212, 191, 0.45);
      border-radius: 8px;
      color: #ccfbf1;
      background: rgba(20, 184, 166, 0.13);
    }

    .update-results {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 0;
      margin: 10px 0 0;
      list-style: none;
    }

    .update-results li {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      min-height: 30px;
      padding: 5px 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      background: #0b1525;
      font-size: 13px;
    }

    .update-results li.ok strong {
      color: var(--ok);
    }

    .update-results li.fail strong {
      color: var(--danger);
    }

    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 0;
      margin: 18px 0;
      list-style: none;
    }

    .summary li {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 38px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--muted);
      font-size: 13px;
    }

    .summary strong {
      color: var(--text);
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 18px;
    }

    .search {
      display: grid;
      grid-template-columns: minmax(220px, 360px) auto;
      gap: 8px;
      align-items: center;
    }

    .search input {
      width: 100%;
      min-height: 38px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b1525;
      color: var(--text);
      font: inherit;
    }

    .edit-form {
      display: grid;
      gap: 14px;
      margin: 10px 0 16px;
      padding: 14px;
      border: 1px solid rgba(45, 212, 191, 0.26);
      border-radius: 8px;
      background:
        linear-gradient(180deg, rgba(45, 212, 191, 0.08), rgba(45, 212, 191, 0)),
        rgba(7, 17, 31, 0.86);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    .edit-form[hidden] {
      display: none;
    }

    .edit-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--line-soft);
    }

    .edit-heading strong,
    .edit-heading span {
      display: block;
    }

    .edit-heading strong {
      color: var(--text);
      font-size: 14px;
      line-height: 1.2;
    }

    .edit-heading span {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }

    .edit-fields {
      display: grid;
      grid-template-columns: minmax(140px, 170px) minmax(150px, 180px) minmax(210px, 240px) minmax(110px, 130px);
      gap: 10px;
      align-items: end;
    }

    .edit-form label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
    }

    .edit-form input,
    .edit-form select {
      width: 100%;
      min-height: 36px;
      padding: 7px 9px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b1525;
      color: var(--text);
      font: inherit;
      font-size: 13px;
    }

    .edit-form input:focus,
    .edit-form select:focus {
      outline: 2px solid rgba(45, 212, 191, 0.28);
      outline-offset: 1px;
      border-color: rgba(45, 212, 191, 0.7);
    }

    .input-suffix {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b1525;
    }

    .input-suffix input {
      border: 0;
      border-radius: 0;
      background: transparent;
    }

    .input-suffix > span {
      display: inline-flex;
      align-items: center;
      min-width: 40px;
      padding: 0 10px;
      border-left: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }

    .edit-form .checkbox-label {
      grid-template-columns: auto 1fr;
      align-items: center;
      gap: 8px;
      min-height: 36px;
    }

    .edit-form input[type="checkbox"] {
      width: 18px;
      height: 18px;
      min-height: 18px;
    }

    .edit-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .primary-button,
    .ghost-button {
      min-height: 36px;
      padding: 7px 12px;
      border-radius: 8px;
      font: inherit;
      font-weight: 800;
    }

    .primary-button {
      border: 1px solid rgba(45, 212, 191, 0.75);
      color: #042f2e;
      background: var(--accent);
    }

    .ghost-button {
      border: 1px solid var(--line);
      color: var(--muted);
      background: rgba(154, 168, 189, 0.08);
    }

    .primary-button:hover,
    .ghost-button:hover,
    .client-row button:hover,
    .client-row a:hover,
    nav a:hover,
    .search button:hover {
      transform: translateY(-1px);
    }

    .search button {
      min-height: 38px;
      padding: 8px 12px;
      border: 1px solid rgba(45, 212, 191, 0.55);
      border-radius: 8px;
      background: rgba(20, 184, 166, 0.1);
    }

    .search-count {
      color: var(--muted);
      font-size: 13px;
    }

    .table-wrap {
      margin-top: 18px;
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 940px;
    }

    th,
    td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line-soft);
      text-align: left;
      vertical-align: middle;
      white-space: nowrap;
    }

    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
      background: rgba(255, 255, 255, 0.03);
    }

    td strong,
    td span {
      display: block;
    }

    td span {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }

    .status {
      display: inline-flex;
      width: max-content;
      min-height: 26px;
      align-items: center;
      padding: 4px 8px;
      border-radius: 999px;
      color: var(--text);
      background: rgba(154, 168, 189, 0.15);
      font-size: 12px;
      font-weight: 800;
    }

    .status.active {
      color: #bbf7d0;
      background: rgba(34, 197, 94, 0.16);
    }

    .status.partial {
      color: #fde68a;
      background: rgba(245, 158, 11, 0.18);
    }

    .status.inactive {
      color: #fecdd3;
      background: rgba(244, 63, 94, 0.18);
    }

    .meter {
      width: 150px;
      height: 9px;
      overflow: hidden;
      border-radius: 999px;
      background: #243044;
    }

    .meter span {
      display: block;
      height: 100%;
      margin: 0;
      background: linear-gradient(90deg, var(--accent), var(--warning), var(--danger));
    }

    details {
      color: var(--muted);
    }

    summary {
      cursor: pointer;
      width: max-content;
      color: #bfdbfe;
      font-weight: 750;
    }

    .panel-row td {
      padding-top: 4px;
      background: rgba(255, 255, 255, 0.02);
    }

    .usage-error {
      margin-top: 10px;
      color: #fecdd3;
      font-size: 13px;
    }

    .source-status {
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
    }

    .panel-table {
      min-width: 860px;
      margin-top: 12px;
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      overflow: hidden;
    }

    .panel-table th,
    .panel-table td {
      padding: 9px 10px;
      font-size: 13px;
    }

    .panel-table tr:last-child td,
    .client-table > tbody > tr:last-child td {
      border-bottom: 0;
    }

    .empty {
      padding: 28px 14px;
      color: var(--muted);
      text-align: center;
    }

    @media (max-width: 720px) {
      header {
        grid-template-columns: 1fr;
        align-items: start;
      }

      nav {
        justify-content: flex-start;
      }

      .toolbar {
        align-items: stretch;
      }

      .search {
        width: 100%;
        grid-template-columns: 1fr;
      }

      .edit-form {
        grid-template-columns: 1fr;
      }

      .edit-heading,
      .edit-actions {
        align-items: stretch;
      }

      .edit-heading {
        flex-direction: column;
      }

      .edit-fields {
        grid-template-columns: 1fr;
      }

      .edit-actions {
        justify-content: stretch;
      }

      .edit-actions button,
      .edit-heading button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Created Configurations</h1>
        <p>${clients.length} matched clients · updated ${escapeHtml(updatedLabel)}</p>
      </div>
      <nav aria-label="Pages">
        <a href="/inbounds">Create</a>
        <a href="/settings">Settings</a>
        <a href="/clients">Refresh</a>
      </nav>
    </header>

    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    ${message ? `<div class="message">${escapeHtml(message)}${updateResultList(updateResults)}</div>` : ''}

    <ul class="summary">
      ${panelSummary(panels)}
    </ul>

    <div class="toolbar">
      <form class="search" data-client-search-form>
        <input
          type="search"
          name="q"
          data-client-search-input
          placeholder="Email or subscription ID"
          aria-label="Search by email or subscription ID"
        >
        <button type="button" data-client-search-clear>Clear</button>
      </form>
      <span class="search-count" data-client-search-count>${clients.length} shown</span>
    </div>

    <div class="table-wrap">
      <table class="client-table">
        <thead>
          <tr>
            <th>Client</th>
            <th>Status</th>
            <th>Normalized Used</th>
            <th>Normalized Total</th>
            <th>Remaining</th>
            <th>Usage</th>
            <th>Subscription</th>
          </tr>
        </thead>
        <tbody>
          ${clientRows(clients)}
        </tbody>
      </table>
    </div>
  </main>
  <script src="/assets/clients.js" defer></script>
</body>
</html>`;
}
