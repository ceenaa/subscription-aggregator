import { randomUUID } from 'node:crypto';

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function requirePanelField(panel, field) {
  if (!panel[field]) {
    throw new Error(`${panel.name} panel is missing ${field} in .env`);
  }

  return panel[field];
}

function parseInteger(value, field, fallback = 0) {
  if (value === undefined || value === '') return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an integer`);
  }

  return parsed;
}

function parseQuotaRatio(value) {
  const parsed = Number.parseFloat(value ?? 1);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('totalGbRatio must be a positive number');
  }

  return parsed;
}

function parseQuotaBytes(value, ratio = 1) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('totalGB must be zero or a positive number');
  }

  return Math.round((parsed / parseQuotaRatio(ratio)) * GIB);
}

function parseExpiryTime(value, startAfterFirstUse) {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error('durationDays must be zero or a positive integer');
  }

  if (days === 0) return 0;
  return startAfterFirstUse ? -days * DAY_MS : Date.now() + days * DAY_MS;
}

function parseEnabled(value) {
  return value !== 'false';
}

function panelEmailUniquenessKey(panel) {
  if (!panel.addClientUrl) return '';

  try {
    const url = new URL(panel.addClientUrl);
    const basePath = url.pathname.replace(/\/api\/inbounds\/addClient\/?$/, '');
    return `${url.origin}${basePath || url.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function addDuplicatePanelEmailSuffixes(panels, input) {
  const indexesByPanel = new Map();

  panels.forEach((panel, index) => {
    const key = panelEmailUniquenessKey(panel);
    if (!key) return;

    const indexes = indexesByPanel.get(key) || [];
    indexes.push(index);
    indexesByPanel.set(key, indexes);
  });

  const suffixByIndex = new Map();
  for (const indexes of indexesByPanel.values()) {
    if (indexes.length < 2) continue;

    indexes.forEach((panelIndex, duplicateIndex) => {
      suffixByIndex.set(panelIndex, duplicateIndex + 1);
    });
  }

  return panels.map((panel, index) => {
    const suffix = suffixByIndex.get(index);
    if (!suffix) return input;

    return {
      ...input,
      email: `${input.email}-${suffix}`
    };
  });
}

export function randomSubId(length = 16) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';

  for (let index = 0; index < length; index += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return result;
}

export function defaultInboundFormValues() {
  return {
    clientId: randomUUID(),
    email: '',
    subId: randomSubId(),
    totalGB: '0',
    durationDays: '0',
    enable: 'true',
    startAfterFirstUse: 'false',
    comment: ''
  };
}

export function buildClientSettings(input, options = {}) {
  const durationDays = input.durationDays ?? input.expiryDays ?? '0';
  const startAfterFirstUse = input.startAfterFirstUse === 'true';
  const totalGbRatio = options.totalGbRatio ?? input.totalGbRatio ?? 1;
  const client = {
    id: input.clientId || randomUUID(),
    flow: '',
    email: input.email || '',
    limitIp: parseInteger(input.limitIp, 'limitIp', 0),
    totalGB: parseQuotaBytes(input.totalGB, totalGbRatio),
    expiryTime: parseExpiryTime(durationDays, startAfterFirstUse),
    enable: parseEnabled(input.enable),
    tgId: '',
    subId: input.subId || randomSubId(),
    comment: input.comment || '',
    reset: 0
  };

  if (!client.email) throw new Error('email is required');
  if (!client.subId) throw new Error('subId is required');

  return {
    clients: [client]
  };
}

export function buildAddClientRequest(panel, input) {
  const addClientUrl = requirePanelField(panel, 'addClientUrl');
  const inboundId = requirePanelField(panel, 'inboundId');
  const url = new URL(addClientUrl);
  const settings = buildClientSettings(input, { totalGbRatio: panel.totalGbRatio });
  const body = new URLSearchParams({
    id: inboundId,
    settings: JSON.stringify(settings, null, 2)
  }).toString();

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Origin: url.origin,
    Referer: `${url.origin}${url.pathname.replace(/\/api\/inbounds\/addClient$/, '/inbounds')}`,
    'X-Requested-With': 'XMLHttpRequest'
  };

  if (panel.cookie) {
    headers.Cookie = panel.cookie;
  }

  return {
    url: addClientUrl,
    method: 'POST',
    body,
    headers,
    settings
  };
}

export async function addClientToPanel(runtime, panel, input) {
  const request = buildAddClientRequest(panel, input);
  const response = await runtime.request(
    {
      name: panel.name,
      proxy: panel.proxy,
      url: request.url
    },
    {
      method: request.method,
      headers: request.headers,
      body: request.body
    }
  );

  let parsedBody = null;
  try {
    parsedBody = JSON.parse(response.body);
  } catch {
    parsedBody = response.body;
  }

  return {
    panel,
    request,
    statusCode: response.statusCode,
    response: parsedBody,
    ok: response.statusCode >= 200 && response.statusCode < 300 && parsedBody?.success !== false
  };
}

export async function addClientToPanels(runtime, panels, input) {
  const panelInputs = addDuplicatePanelEmailSuffixes(panels, input);

  return Promise.all(
    panels.map(async (panel, index) => {
      try {
        return await addClientToPanel(runtime, panel, panelInputs[index]);
      } catch (error) {
        return {
          panel,
          ok: false,
          error: error.message
        };
      }
    })
  );
}
