import { renderQrSvg } from './qr.js';
import { formatBytes, formatExpiry, usageFromResult } from './usage.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function percentage(used, total) {
  if (!total) return 0;
  return Math.min(Math.max((used / total) * 100, 0), 100);
}

function usageRows(usage) {
  if (!usage.hasData) {
    return '<p class="empty">No usage headers were returned by this upstream.</p>';
  }

  return `
    <div class="meter" aria-label="Usage">
      <span style="width: ${percentage(usage.used, usage.total).toFixed(2)}%"></span>
    </div>
    <dl class="stats">
      <div><dt>Total quota</dt><dd>${formatBytes(usage.total)}</dd></div>
      <div><dt>Used</dt><dd>${formatBytes(usage.used)}</dd></div>
      <div><dt>Remaining</dt><dd>${formatBytes(usage.remaining)}</dd></div>
      <div><dt>Downloaded</dt><dd>${formatBytes(usage.download)}</dd></div>
      <div><dt>Uploaded</dt><dd>${formatBytes(usage.upload)}</dd></div>
      <div><dt>Expiry</dt><dd>${escapeHtml(formatExpiry(usage.expire))}</dd></div>
    </dl>
  `;
}

function sourceCard(result) {
  const usage = usageFromResult(result);
  const sourceName = escapeHtml(result.source.name);
  const proxyLabel = result.source.proxy === 'xray' ? 'Xray routed' : 'Direct';

  return `
    <section class="source-card">
      <div class="source-heading">
        <div>
          <h2>${sourceName}</h2>
          <p>${escapeHtml(proxyLabel)} upstream</p>
        </div>
        <span>${result.count} link${result.count === 1 ? '' : 's'}</span>
      </div>
      ${usageRows(usage)}
    </section>
  `;
}

function subscriptionLinks(links) {
  if (links.length === 0) return '<p class="empty">No subscription links were returned.</p>';

  return links
    .map(
      (link) => `
        <li>
          <code>${escapeHtml(link)}</code>
        </li>
      `
    )
    .join('');
}

export function renderSubscriptionPage({
  token,
  subscriptionUrl,
  plainUrl,
  base64Url,
  result,
  updatedAt = new Date()
}) {
  const qrSvg = renderQrSvg(subscriptionUrl);
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
  <title>Subscription ${escapeHtml(token)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: #111c2e;
      --panel-strong: #17243a;
      --line: #2a3952;
      --text: #eef3fb;
      --muted: #9aa8bd;
      --accent: #2dd4bf;
      --accent-2: #e879f9;
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
      width: min(1100px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 48px;
    }

    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      padding: 22px 0 24px;
      border-bottom: 1px solid var(--line);
    }

    h1, h2, p {
      margin: 0;
    }

    h1 {
      font-size: clamp(26px, 4vw, 42px);
      line-height: 1.05;
      font-weight: 760;
    }

    header p {
      margin-top: 10px;
      color: var(--muted);
      font-size: 15px;
    }

    .token {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      min-height: 34px;
      margin-top: 14px;
      padding: 6px 12px;
      border: 1px solid rgba(232, 121, 249, 0.55);
      border-radius: 999px;
      color: #f0abfc;
      background: rgba(88, 28, 135, 0.22);
      font-size: 14px;
      overflow-wrap: anywhere;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: flex-end;
    }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      padding: 8px 13px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      background: var(--panel);
      text-decoration: none;
      font-size: 14px;
      font-weight: 650;
    }

    .button.primary {
      border-color: rgba(45, 212, 191, 0.75);
      color: #99f6e4;
      background: rgba(20, 184, 166, 0.14);
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(260px, 330px) 1fr;
      gap: 22px;
      margin-top: 28px;
      align-items: start;
    }

    .qr-panel,
    .source-card,
    .links-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    .qr-panel {
      padding: 18px;
    }

    .qr-box {
      width: 100%;
      aspect-ratio: 1;
      padding: 12px;
      border-radius: 8px;
      background: #fff;
    }

    .qr-box svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    .url-box {
      margin-top: 14px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b1525;
      color: #dbeafe;
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .update-note {
      margin-top: 14px;
      padding: 12px;
      border: 1px solid rgba(45, 212, 191, 0.45);
      border-radius: 8px;
      background: rgba(20, 184, 166, 0.12);
    }

    .update-note strong {
      display: block;
      color: #99f6e4;
      font-size: 13px;
    }

    .update-note p {
      margin-top: 5px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }

    .sources {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }

    .source-card {
      overflow: hidden;
    }

    .source-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-strong);
    }

    .source-heading h2 {
      font-size: 18px;
      line-height: 1.2;
    }

    .source-heading p {
      margin-top: 5px;
      color: var(--muted);
      font-size: 13px;
    }

    .source-heading span {
      flex: 0 0 auto;
      padding: 5px 10px;
      border: 1px solid rgba(45, 212, 191, 0.45);
      border-radius: 999px;
      color: #99f6e4;
      font-size: 12px;
      font-weight: 700;
    }

    .meter {
      height: 10px;
      margin: 18px 18px 0;
      overflow: hidden;
      border-radius: 999px;
      background: #25344a;
    }

    .meter span {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
    }

    .stats {
      margin: 18px 0 0;
      border-top: 1px solid var(--line);
    }

    .stats div {
      display: grid;
      grid-template-columns: minmax(110px, 0.9fr) minmax(0, 1.1fr);
      gap: 14px;
      padding: 13px 18px;
      border-bottom: 1px solid var(--line);
    }

    dt {
      color: var(--muted);
      font-weight: 650;
    }

    dd {
      margin: 0;
      color: var(--text);
      overflow-wrap: anywhere;
      text-align: right;
    }

    .empty {
      padding: 18px;
      color: var(--muted);
    }

    .links-panel {
      margin-top: 16px;
      padding: 18px;
    }

    .links-panel h2 {
      font-size: 18px;
      margin-bottom: 14px;
    }

    .links-panel ul {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .links-panel li {
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b1525;
    }

    code {
      color: #dbeafe;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    @media (max-width: 860px) {
      header {
        display: block;
      }

      .actions {
        justify-content: flex-start;
        margin-top: 18px;
      }

      .grid,
      .sources {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Subscription Info</h1>
        <p>Aggregated usage is shown separately for each upstream subscription.</p>
        <span class="token">${escapeHtml(token)}</span>
      </div>
      <nav class="actions" aria-label="Subscription actions">
        <a class="button primary" href="${escapeHtml(base64Url)}">Subscription</a>
        <a class="button" href="${escapeHtml(plainUrl)}">Plain Links</a>
      </nav>
    </header>

    <section class="grid">
      <aside class="qr-panel">
        <div class="qr-box">${qrSvg}</div>
        <div class="url-box">${escapeHtml(subscriptionUrl)}</div>
        <div class="update-note">
          <strong>Last updated: ${escapeHtml(updatedLabel)}</strong>
          <p>Please update your subscription link daily to keep configs and usage information current.</p>
        </div>
      </aside>

      <div>
        <section class="sources">
          ${result.results.map(sourceCard).join('')}
        </section>

        <section class="links-panel">
          <h2>Aggregated Links</h2>
          <ul>${subscriptionLinks(result.links)}</ul>
        </section>
      </div>
    </section>
  </main>
</body>
</html>`;
}
