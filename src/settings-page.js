function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function selected(value, expected) {
  return value === expected ? 'selected' : '';
}

function checked(value) {
  return value ? 'checked' : '';
}

function proxyOptions(value, includePanelRoute = false) {
  const normalized = value || (includePanelRoute ? '' : 'direct');
  return `
    ${includePanelRoute ? `<option value="" ${selected(normalized, '')}>Panel route</option>` : ''}
    <option value="direct" ${selected(normalized, 'direct')}>Direct</option>
    <option value="xray" ${selected(normalized, 'xray')}>Xray</option>
  `;
}

function field(name, label, value = '', options = {}) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input
        name="${escapeHtml(name)}"
        value="${escapeHtml(value)}"
        ${options.type ? `type="${escapeHtml(options.type)}"` : 'type="text"'}
        ${options.required ? 'required' : ''}
        ${options.min !== undefined ? `min="${escapeHtml(options.min)}"` : ''}
        ${options.max !== undefined ? `max="${escapeHtml(options.max)}"` : ''}
        ${options.step !== undefined ? `step="${escapeHtml(options.step)}"` : ''}
        ${options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ''}
      >
    </label>
  `;
}

function textarea(name, label, value = '') {
  return `
    <label class="wide">
      <span>${escapeHtml(label)}</span>
      <textarea name="${escapeHtml(name)}" rows="3">${escapeHtml(value)}</textarea>
    </label>
  `;
}

function panelSelect(panels, value = '') {
  return `
    <label>
      <span>Panel</span>
      <select name="panelId" required>
        <option value="">Select panel</option>
        ${panels
          .map(
            (panel) => `
              <option value="${escapeHtml(panel.id)}" ${selected(String(value), String(panel.id))}>
                ${escapeHtml(panel.name)}
              </option>
            `
          )
          .join('')}
      </select>
    </label>
  `;
}

function panelForm(panel = null) {
  const isEdit = Boolean(panel);
  return `
    <form method="post" action="${isEdit ? '/settings/panels/edit' : '/settings/panels'}" class="config-form">
      ${isEdit ? `<input type="hidden" name="id" value="${escapeHtml(panel.id)}">` : ''}
      <div class="fields panel-fields">
        ${field('name', 'Name', panel?.name || '', { required: true })}
        ${field('addClientUrl', 'Add Client URL', panel?.add_client_url || '', {
          required: true,
          placeholder: 'https://panel.example/path/api/clients/add'
        })}
        <label>
          <span>API Route</span>
          <select name="proxy">${proxyOptions(panel?.proxy || 'direct')}</select>
        </label>
        <label class="toggle-row">
          <span>Enabled</span>
          <input type="checkbox" name="enabled" value="true" ${checked(panel ? panel.enabled : true)}>
        </label>
        ${textarea('cookie', 'Cookie', panel?.cookie || '')}
      </div>
      <div class="actions">
        <button type="submit">${isEdit ? 'Save Panel' : 'Add Panel'}</button>
      </div>
    </form>
  `;
}

function inboundForm(panels, inbound = null) {
  const isEdit = Boolean(inbound);
  return `
    <form method="post" action="${isEdit ? '/settings/inbounds/edit' : '/settings/inbounds'}" class="config-form">
      ${isEdit ? `<input type="hidden" name="id" value="${escapeHtml(inbound.id)}">` : ''}
      <div class="fields inbound-fields">
        ${panelSelect(panels, inbound?.panel_id || '')}
        ${field('name', 'Name', inbound?.name || '', { placeholder: 'EU 443' })}
        ${field('inboundId', 'Inbound ID', inbound?.inbound_id || '', { required: true })}
        ${field('totalGbRatio', 'Total GB Ratio', inbound?.total_gb_ratio ?? '1', {
          type: 'number',
          min: '0.0001',
          step: '0.0001',
          required: true
        })}
        ${field('quotaDivisor', 'Quota Divisor', inbound?.quota_divisor ?? '1', {
          type: 'number',
          min: '0.0001',
          step: '0.0001',
          required: true
        })}
        ${field('subscriptionName', 'Subscription Name', inbound?.subscription_name || '')}
        ${field('subscriptionBaseUrl', 'Subscription Base URL', inbound?.subscription_base_url || '', {
          placeholder: 'https://provider.example/sub'
        })}
        <label>
          <span>Subscription Route</span>
          <select name="subscriptionProxy">${proxyOptions(inbound?.subscription_proxy || '', true)}</select>
        </label>
        <label class="toggle-row">
          <span>XTLS Vision Flow</span>
          <input
            type="checkbox"
            name="xtlsVisionFlow"
            value="true"
            ${checked(inbound ? inbound.xtls_vision_flow : false)}
          >
        </label>
        <label class="toggle-row">
          <span>Enabled</span>
          <input type="checkbox" name="enabled" value="true" ${checked(inbound ? inbound.enabled : true)}>
        </label>
      </div>
      <div class="actions">
        <button type="submit">${isEdit ? 'Save Inbound' : 'Add Inbound'}</button>
      </div>
    </form>
  `;
}

function deleteForm(action, id, label) {
  return `
    <form method="post" action="${escapeHtml(action)}" class="delete-form">
      <input type="hidden" name="id" value="${escapeHtml(id)}">
      <button type="submit">${escapeHtml(label)}</button>
    </form>
  `;
}

function panelList(panels) {
  if (panels.length === 0) {
    return '<p class="empty">No panels have been added.</p>';
  }

  return panels
    .map(
      (panel) => `
        <section class="entry">
          <div class="entry-heading">
            <div>
              <h3>${escapeHtml(panel.name)}</h3>
              <p>${escapeHtml(panel.proxy)} API route · ${escapeHtml(panel.inboundCount)} inbounds · ${panel.enabled ? 'enabled' : 'disabled'}</p>
            </div>
            ${deleteForm('/settings/panels/delete', panel.id, 'Delete')}
          </div>
          ${panelForm(panel)}
        </section>
      `
    )
    .join('');
}

function inboundList(panels, inbounds) {
  if (inbounds.length === 0) {
    return '<p class="empty">No inbounds have been added.</p>';
  }

  return inbounds
    .map(
      (inbound) => `
        <section class="entry">
          <div class="entry-heading">
            <div>
              <h3>${escapeHtml(inbound.name || `${inbound.panelName} inbound ${inbound.inbound_id}`)}</h3>
              <p>
                ${escapeHtml(inbound.panelName)}
                · inbound ${escapeHtml(inbound.inbound_id)}
                · ratio ${escapeHtml(inbound.total_gb_ratio)}
                ${inbound.xtls_vision_flow ? ' · XTLS vision flow' : ''}
                · ${inbound.enabled ? 'enabled' : 'disabled'}
              </p>
            </div>
            ${deleteForm('/settings/inbounds/delete', inbound.id, 'Delete')}
          </div>
          ${inboundForm(panels, inbound)}
        </section>
      `
    )
    .join('');
}

export function renderSettingsPage({
  panels = [],
  inbounds = [],
  databasePath = '',
  error = '',
  message = ''
}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Panel Settings</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: #101b2d;
      --panel-soft: #0b1525;
      --line: #2a3952;
      --text: #eef3fb;
      --muted: #9aa8bd;
      --accent: #2dd4bf;
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

    h1, h2, h3, p {
      margin: 0;
    }

    h1 {
      font-size: clamp(28px, 4vw, 40px);
      line-height: 1.05;
    }

    header p,
    .entry-heading p,
    .empty {
      margin-top: 8px;
      color: var(--muted);
      font-size: 14px;
    }

    nav {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 10px;
    }

    nav a,
    button {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 12px;
      border: 1px solid rgba(45, 212, 191, 0.55);
      border-radius: 8px;
      color: #99f6e4;
      background: rgba(20, 184, 166, 0.1);
      font: inherit;
      font-weight: 750;
      text-decoration: none;
      cursor: pointer;
    }

    .message,
    .error {
      margin-top: 18px;
      padding: 12px 14px;
      border-radius: 8px;
    }

    .message {
      border: 1px solid rgba(45, 212, 191, 0.45);
      color: #ccfbf1;
      background: rgba(20, 184, 166, 0.13);
    }

    .error {
      border: 1px solid rgba(251, 113, 133, 0.45);
      color: #fecdd3;
      background: rgba(127, 29, 29, 0.28);
    }

    .section {
      margin-top: 24px;
      padding-top: 22px;
      border-top: 1px solid var(--line);
    }

    .section h2 {
      font-size: 20px;
      line-height: 1.2;
    }

    .config-form {
      margin-top: 14px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    .fields {
      display: grid;
      gap: 12px;
    }

    .panel-fields {
      grid-template-columns: minmax(140px, 1fr) minmax(280px, 2fr) minmax(130px, 160px) minmax(110px, 130px);
    }

    .inbound-fields {
      grid-template-columns: repeat(4, minmax(150px, 1fr));
    }

    label {
      display: grid;
      gap: 7px;
    }

    label span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
    }

    input,
    select,
    textarea {
      width: 100%;
      min-height: 40px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
      color: var(--text);
      font: inherit;
    }

    textarea {
      min-height: 78px;
      resize: vertical;
    }

    .wide {
      grid-column: 1 / -1;
    }

    .toggle-row {
      grid-template-columns: 1fr auto;
      align-items: center;
    }

    input[type="checkbox"] {
      width: 20px;
      min-height: 20px;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 14px;
    }

    .entry {
      margin-top: 14px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
    }

    .entry .config-form {
      background: rgba(16, 27, 45, 0.78);
    }

    .entry-heading {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
    }

    .entry-heading h3 {
      font-size: 16px;
      line-height: 1.25;
    }

    .delete-form button {
      border-color: rgba(251, 113, 133, 0.55);
      color: #fecdd3;
      background: rgba(127, 29, 29, 0.2);
    }

    @media (max-width: 860px) {
      header,
      .entry-heading {
        grid-template-columns: 1fr;
      }

      nav {
        justify-content: flex-start;
      }

      .panel-fields,
      .inbound-fields {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Panel Settings</h1>
        <p>${escapeHtml(databasePath)}</p>
      </div>
      <nav aria-label="Pages">
        <a href="/inbounds">Create</a>
        <a href="/clients">Clients</a>
        <a href="/settings">Refresh</a>
      </nav>
    </header>

    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    ${message ? `<div class="message">${escapeHtml(message)}</div>` : ''}

    <section class="section">
      <h2>Add Panel</h2>
      ${panelForm()}
    </section>

    <section class="section">
      <h2>Panels</h2>
      ${panelList(panels)}
    </section>

    <section class="section">
      <h2>Add Inbound</h2>
      ${panels.length > 0 ? inboundForm(panels) : '<p class="empty">Add a panel before adding inbounds.</p>'}
    </section>

    <section class="section">
      <h2>Inbounds</h2>
      ${inboundList(panels, inbounds)}
    </section>
  </main>
</body>
</html>`;
}
