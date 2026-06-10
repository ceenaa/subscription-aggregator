import { defaultInboundFormValues } from './panel-client.js';
import { renderQrSvg } from './qr.js';
import { subscriptionAppLinks } from './app-links.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function field(name, label, value, options = {}) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input
        name="${escapeHtml(name)}"
        value="${escapeHtml(value)}"
        ${options.type ? `type="${escapeHtml(options.type)}"` : 'type="text"'}
        ${options.required ? 'required' : ''}
        ${options.min !== undefined ? `min="${escapeHtml(options.min)}"` : ''}
        ${options.step !== undefined ? `step="${escapeHtml(options.step)}"` : ''}
      >
    </label>
  `;
}

function fieldWithAction(name, label, value, buttonLabel, actionAttribute, options = {}) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <div class="field-action">
        <input
          name="${escapeHtml(name)}"
          value="${escapeHtml(value)}"
          ${options.type ? `type="${escapeHtml(options.type)}"` : 'type="text"'}
          ${options.required ? 'required' : ''}
          ${options.min !== undefined ? `min="${escapeHtml(options.min)}"` : ''}
          ${options.step !== undefined ? `step="${escapeHtml(options.step)}"` : ''}
        >
        <button type="button" ${escapeHtml(actionAttribute)}>${escapeHtml(buttonLabel)}</button>
      </div>
    </label>
  `;
}

function toggle(name, label, value) {
  const checked = value !== 'false';

  return `
    <label class="toggle-row">
      <span>${escapeHtml(label)}</span>
      <input type="checkbox" name="${escapeHtml(name)}" value="true" ${checked ? 'checked' : ''}>
    </label>
  `;
}

function resultRows(results) {
  if (!results) return '';

  return `
    <section class="results">
      <h2>Create Result</h2>
      <div class="result-grid">
        ${results
          .map((result) => {
            const status = result.ok ? 'Success' : 'Failed';
            const message =
              result.error ||
              result.response?.msg ||
              (typeof result.response === 'string' ? result.response : 'Request completed');

            return `
              <article class="result ${result.ok ? 'ok' : 'fail'}">
                <div>
                  <h3>${escapeHtml(result.panel.name)}</h3>
                  <p>${escapeHtml(result.panel.proxy)} request</p>
                </div>
                <strong>${escapeHtml(status)}</strong>
                <pre>${escapeHtml(message)}</pre>
              </article>
            `;
          })
          .join('')}
      </div>
    </section>
  `;
}

function appLinkButtons(subscriptionUrl, name) {
  return subscriptionAppLinks(subscriptionUrl, name)
    .map(
      (link) => `
        <a href="${escapeHtml(link.href)}">
          <img src="${escapeHtml(link.icon)}" alt="" aria-hidden="true">
          <span>${escapeHtml(link.label)}</span>
        </a>
      `
    )
    .join('');
}

function subscriptionResult(subscription) {
  if (!subscription) return '';
  const name = subscription.name || 'Subscription';

  return `
    <section class="subscription-result">
      <div>
        <h2>Aggregated Subscription</h2>
        <p>Use this link for the client created on every configured inbound.</p>
      </div>
      <div class="subscription-layout">
        <div class="qr-box">${renderQrSvg(subscription.url)}</div>
        <div class="subscription-details">
          <div
            class="url-box copy-box"
            data-copy-text="${escapeHtml(subscription.url)}"
            role="button"
            tabindex="0"
            aria-label="Copy aggregated subscription URL"
          >${escapeHtml(subscription.url)}</div>
          <p class="copy-hint" data-copy-hint>Click the URL to copy it.</p>
          <div class="link-actions">
            <a href="${escapeHtml(subscription.url)}">Info Page</a>
            <a href="${escapeHtml(subscription.base64Url)}">Base64</a>
            <a href="${escapeHtml(subscription.plainUrl)}">Plain</a>
          </div>
          <div class="app-actions" aria-label="Open subscription in app">
            ${appLinkButtons(subscription.url, name)}
          </div>
        </div>
      </div>
    </section>
  `;
}

export function renderInboundsPage({
  values = defaultInboundFormValues(),
  results = null,
  subscription = null,
  error = ''
}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Create Inbound Clients</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: #111c2e;
      --line: #2a3952;
      --text: #eef3fb;
      --muted: #9aa8bd;
      --accent: #2dd4bf;
      --danger: #fb7185;
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
      width: min(920px, calc(100% - 32px));
      margin: 0 auto;
      padding: 34px 0 48px;
    }

    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: end;
      padding-bottom: 22px;
      border-bottom: 1px solid var(--line);
    }

    h1, h2, h3, p {
      margin: 0;
    }

    h1 {
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1.05;
    }

    header p {
      margin-top: 10px;
      color: var(--muted);
    }

    nav {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 10px;
    }

    nav a {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 12px;
      border: 1px solid rgba(45, 212, 191, 0.55);
      border-radius: 8px;
      color: #99f6e4;
      background: rgba(20, 184, 166, 0.1);
      text-decoration: none;
      font-weight: 750;
    }

    form,
    .results,
    .subscription-result {
      margin-top: 24px;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    .fields {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }

    label {
      display: grid;
      gap: 7px;
    }

    .toggle-row {
      grid-template-columns: minmax(150px, 1fr) auto;
      align-items: center;
      min-height: 42px;
    }

    label span {
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }

    input {
      width: 100%;
      min-height: 42px;
      padding: 9px 11px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b1525;
      color: var(--text);
      font: inherit;
    }

    .field-action {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
    }

    .field-action button {
      min-width: 96px;
      white-space: nowrap;
    }

    input[type="checkbox"] {
      width: 56px;
      height: 30px;
      min-height: 30px;
      padding: 0;
      border-radius: 999px;
      appearance: none;
      background: #26344c;
      cursor: pointer;
      position: relative;
    }

    input[type="checkbox"]::before {
      content: "";
      position: absolute;
      width: 24px;
      height: 24px;
      top: 2px;
      left: 3px;
      border-radius: 50%;
      background: #fff;
      transition: transform 140ms ease;
    }

    input[type="checkbox"]:checked {
      background: #0d9488;
    }

    input[type="checkbox"]:checked::before {
      transform: translateX(26px);
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 18px;
    }

    button {
      min-height: 42px;
      padding: 9px 16px;
      border: 1px solid rgba(45, 212, 191, 0.7);
      border-radius: 8px;
      color: #99f6e4;
      background: rgba(20, 184, 166, 0.14);
      font: inherit;
      font-weight: 750;
      cursor: pointer;
    }

    .error {
      margin-top: 18px;
      padding: 12px 14px;
      border: 1px solid rgba(251, 113, 133, 0.45);
      border-radius: 8px;
      color: #fecdd3;
      background: rgba(127, 29, 29, 0.28);
    }

    .result-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-top: 16px;
    }

    .subscription-result {
      display: grid;
      gap: 16px;
      border-color: rgba(45, 212, 191, 0.55);
    }

    .subscription-result p {
      margin-top: 6px;
      color: var(--muted);
    }

    .subscription-layout {
      display: grid;
      grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }

    .qr-box {
      width: 100%;
      aspect-ratio: 1;
      padding: 10px;
      border-radius: 8px;
      background: #fff;
    }

    .qr-box svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    .subscription-details {
      display: grid;
      gap: 12px;
    }

    .url-box {
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b1525;
      color: #dbeafe;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.5;
    }

    .copy-box {
      cursor: pointer;
    }

    .copy-box:focus {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .copy-box[data-copied="true"] {
      border-color: rgba(45, 212, 191, 0.8);
      color: #99f6e4;
    }

    .copy-hint {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
    }

    .link-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .app-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .link-actions a,
    .app-actions a {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: #99f6e4;
      background: #0b1525;
      text-decoration: none;
      font-weight: 700;
    }

    .app-actions a {
      border-color: rgba(45, 212, 191, 0.5);
      background: rgba(20, 184, 166, 0.1);
    }

    .app-actions img {
      width: 22px;
      height: 22px;
      flex: 0 0 22px;
      border-radius: 6px;
      object-fit: cover;
    }

    .result {
      display: grid;
      gap: 12px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b1525;
    }

    .result.ok {
      border-color: rgba(45, 212, 191, 0.55);
    }

    .result.fail {
      border-color: rgba(251, 113, 133, 0.55);
    }

    .result p {
      margin-top: 5px;
      color: var(--muted);
      font-size: 13px;
    }

    .result strong {
      color: var(--accent);
    }

    .result.fail strong {
      color: var(--danger);
    }

    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #dbeafe;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.45;
    }

    @media (max-width: 720px) {
      .fields,
      .result-grid,
      .subscription-layout {
        grid-template-columns: 1fr;
      }

      header {
        grid-template-columns: 1fr;
        align-items: start;
      }

      nav {
        justify-content: flex-start;
      }

      .field-action {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Create Inbound Clients</h1>
        <p>Add the same client to every configured 3x-ui inbound. Each panel can use its own direct or Xray route.</p>
      </div>
      <nav aria-label="Pages">
        <a href="/clients">Clients</a>
        <a href="/settings">Settings</a>
      </nav>
    </header>

    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

    <form method="post" action="/inbounds">
      <div class="fields">
        ${toggle('enable', 'Enabled', values.enable)}
        ${fieldWithAction('email', 'Email', values.email, 'Generate', 'data-random-email', { required: true })}
        ${field('clientId', 'ID', values.clientId, { required: true })}
        ${field('subId', 'Subscription', values.subId, { required: true })}
        ${field('comment', 'Comment', values.comment)}
        ${field('totalGB', 'Base Total Flow (GB)', values.totalGB, { type: 'number', min: '0', step: '0.01', required: true })}
        ${toggle('startAfterFirstUse', 'Start After First Use', values.startAfterFirstUse)}
        ${field('durationDays', 'Duration (days)', values.durationDays, { type: 'number', min: '0', step: '1', required: true })}
      </div>
      <div class="actions">
        <button type="submit">Create Client</button>
      </div>
    </form>

    ${resultRows(results)}
    ${subscriptionResult(subscription)}
  </main>
  <script src="/assets/inbounds.js" defer></script>
</body>
</html>`;
}
