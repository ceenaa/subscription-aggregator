import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import { createSubscriptionFetcher } from './runtime.js';

function requirePanelField(panel, field) {
  if (!panel[field]) {
    throw new Error(`${panel.name} panel is missing ${field} in .env`);
  }

  return panel[field];
}

function panelApiBase(panel) {
  const addClientUrl = new URL(requirePanelField(panel, 'addClientUrl'));
  const basePath = addClientUrl.pathname.replace(/\/api\/inbounds\/addClient\/?$/, '/api/inbounds');
  if (basePath === addClientUrl.pathname) {
    throw new Error(`${panel.name} panel addClient URL must end with /api/inbounds/addClient`);
  }

  return {
    origin: addClientUrl.origin,
    path: basePath
  };
}

function panelApiUrl(panel, endpoint) {
  const base = panelApiBase(panel);
  return `${base.origin}${base.path}/${endpoint}`;
}

function panelReferer(apiUrl) {
  const url = new URL(apiUrl);
  return `${url.origin}${url.pathname.replace(/\/api\/inbounds\/(?:list|updateClient\/[^/]+)\/?$/, '/inbounds')}`;
}

function panelHeaders(panel, url, options = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: panelReferer(url),
    'X-Requested-With': 'XMLHttpRequest'
  };

  if (options.body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    headers.Origin = new URL(url).origin;
  }

  if (panel.cookie) {
    headers.Cookie = panel.cookie;
  }

  return headers;
}

function parseJsonObject(text, context) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${context} did not return JSON`);
  }

  if (parsed?.success === false) {
    throw new Error(`${context} failed: ${parsed.msg || 'unknown panel error'}`);
  }

  return parsed;
}

function parseInboundSettings(inbound, panelName) {
  if (!inbound?.settings) return { clients: [] };

  try {
    const settings = typeof inbound.settings === 'string' ? JSON.parse(inbound.settings) : inbound.settings;
    return settings && typeof settings === 'object' ? settings : { clients: [] };
  } catch {
    throw new Error(`${panelName} inbound ${inbound.id} has invalid settings JSON`);
  }
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function updateClientId(client, stat) {
  return client.id || client.uuid || stat?.uuid || '';
}

function isEnabledValue(value) {
  return value !== false && value !== 0 && value !== 'false';
}

function clientLooksEnabled(entry) {
  if (entry.stat && entry.stat.enable !== undefined) {
    return isEnabledValue(entry.stat.enable);
  }

  return isEnabledValue(entry.client.enable);
}

function formatPanelList(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function normalizedCombinedUsage(entries) {
  if (entries.some((entry) => entry.total <= 0)) {
    return {
      total: 0,
      used: 0,
      scale: 0,
      scales: []
    };
  }

  const lower = entries.reduce((lowest, entry) => (entry.total < lowest.total ? entry : lowest), entries[0]);
  const scales = entries.map((entry) => entry.total / lower.total);

  return {
    total: lower.total,
    used: entries.reduce((sum, entry, index) => sum + entry.allTime / scales[index], 0),
    scale: Math.max(...scales),
    scales
  };
}

async function mapLimit(items, concurrency, mapper) {
  const limit = Math.max(1, Number.parseInt(concurrency, 10) || 1);
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

export function buildListInboundsRequest(panel) {
  const url = panelApiUrl(panel, 'list');

  return {
    url,
    method: 'GET',
    headers: panelHeaders(panel, url)
  };
}

export function buildUpdateClientRequest(panel, inbound, client, stat = null) {
  const clientId = updateClientId(client, stat);
  if (!clientId) {
    throw new Error(`${panel.name} client ${client.email || client.subId || 'unknown'} is missing an update id`);
  }

  const url = panelApiUrl(panel, `updateClient/${encodeURIComponent(clientId)}`);
  const body = new URLSearchParams({
    id: String(inbound.id),
    settings: JSON.stringify(
      {
        clients: [
          {
            ...client,
            enable: false
          }
        ]
      },
      null,
      2
    )
  }).toString();

  return {
    url,
    method: 'POST',
    body,
    headers: panelHeaders(panel, url, { body })
  };
}

export function indexInboundClients(panel, inbound) {
  const settings = parseInboundSettings(inbound, panel.name);
  const statsBySubId = new Map();

  for (const stat of inbound.clientStats || []) {
    if (stat?.subId) {
      statsBySubId.set(String(stat.subId), stat);
    }
  }

  const clients = new Map();
  for (const client of settings.clients || []) {
    if (!client?.subId) continue;

    const subId = String(client.subId);
    const stat = statsBySubId.get(subId);
    clients.set(subId, {
      panel,
      inbound,
      client,
      stat,
      subId,
      email: client.email || stat?.email || '',
      total: numberOrZero(stat?.total ?? client.totalGB),
      allTime: numberOrZero(stat?.allTime)
    });
  }

  return clients;
}

export function evaluateQuotaGroup(entries) {
  const reasons = [];

  for (const entry of entries) {
    if (entry.total > 0 && entry.allTime >= entry.total) {
      reasons.push(`${entry.panel.name} quota exceeded`);
    }
  }

  const combined = normalizedCombinedUsage(entries);

  if (combined.total > 0 && combined.used >= combined.total) {
    reasons.push('combined normalized quota exceeded');
  }

  return {
    exceeded: reasons.length > 0,
    reasons,
    combinedTotal: combined.total,
    combinedAllTime: combined.used,
    combinedScale: combined.scale,
    combinedScales: combined.scales
  };
}

export function evaluateQuotaPair(first, second) {
  return evaluateQuotaGroup([first, second]);
}

async function requestPanelJson(runtime, panel, request) {
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

  return parseJsonObject(response.body, panel.name);
}

async function fetchPanelInbound(runtime, panel) {
  const request = buildListInboundsRequest(panel);
  const payload = await requestPanelJson(runtime, panel, request);
  const inbounds = Array.isArray(payload.obj) ? payload.obj : [];
  const inbound = inbounds.find((item) => String(item.id) === String(panel.inboundId));

  return {
    panel,
    inbound: inbound || null,
    clients: inbound ? indexInboundClients(panel, inbound) : new Map()
  };
}

async function disableClient(runtime, entry) {
  const request = buildUpdateClientRequest(entry.panel, entry.inbound, entry.client, entry.stat);
  const payload = await requestPanelJson(runtime, entry.panel, request);

  return {
    panel: entry.panel.name,
    subId: entry.subId,
    email: entry.email,
    response: payload.msg || 'updated'
  };
}

async function processQuotaGroup(runtime, group, options) {
  const { entries } = group;
  const dryRun = options.dryRun === true;
  const skipped = [];
  const evaluation = evaluateQuotaGroup(entries);
  if (!evaluation.exceeded) return { disabled: null, partialDisabled: null, skipped };

  const targets = entries.filter(clientLooksEnabled);
  const updates = await Promise.all(
    targets.map(async (target) => {
      if (!updateClientId(target.client, target.stat)) {
        return {
          skipped: {
            subId: target.subId,
            email: target.email,
            panel: target.panel.name,
            reason: 'client update id missing'
          }
        };
      }

      try {
        return {
          update: dryRun
            ? {
                panel: target.panel.name,
                subId: target.subId,
                email: target.email,
                response: 'dry run'
              }
            : await disableClient(runtime, target)
        };
      } catch (error) {
        return {
          skipped: {
            subId: target.subId,
            email: target.email,
            panel: target.panel.name,
            reason: `disable failed: ${error.message}`
          }
        };
      }
    })
  );
  const panelUpdates = [];

  for (const result of updates) {
    if (result.update) panelUpdates.push(result.update);
    if (result.skipped) skipped.push(result.skipped);
  }

  if (panelUpdates.length === 0) {
    return {
      disabled: null,
      partialDisabled: null,
      skipped
    };
  }

  const updateResult = {
    subId: group.subId,
    email: entries.find((entry) => entry.email)?.email || '',
    reasons: evaluation.reasons,
    panels: panelUpdates
  };

  return {
    disabled: panelUpdates.length === targets.length ? updateResult : null,
    partialDisabled:
      panelUpdates.length === targets.length
        ? null
        : {
            ...updateResult,
            failed: skipped
          },
    skipped
  };
}

export async function enforcePanelQuota(runtime, panels, options = {}) {
  const logger = options.logger || console;
  const concurrency = options.concurrency || 5;
  const configuredPanels = panels.filter(Boolean);
  if (configuredPanels.length < 2) {
    throw new Error('At least two panels must be configured before running the quota worker');
  }

  const panelStates = await Promise.all(configuredPanels.map((panel) => fetchPanelInbound(runtime, panel)));

  const disabled = [];
  const partialDisabled = [];
  const skipped = [];

  const missingInboundPanels = panelStates.filter((state) => !state.inbound).map((state) => state.panel.name);
  if (missingInboundPanels.length > 0) {
    const result = {
      checked: 0,
      disabled,
      partialDisabled,
      skipped: [
        {
          reason: 'configured inbound is missing from one or more panels',
          missingPanels: missingInboundPanels
        }
      ]
    };
    logger.log('quota worker checked 0 clients');
    logger.log('disabled clients: 0');
    logger.log('partial disabled clients: 0');
    logger.log(`skipped clients: ${result.skipped.length}`);
    return result;
  }

  const allSubIds = new Set();
  for (const state of panelStates) {
    for (const subId of state.clients.keys()) {
      allSubIds.add(subId);
    }
  }

  const groups = [];
  for (const subId of allSubIds) {
    const entries = panelStates.map((state) => state.clients.get(subId) || null);
    const presentEntries = entries.filter(Boolean);
    const email = presentEntries.find((entry) => entry.email)?.email || '';
    const missingPanels = panelStates
      .filter((state, index) => !entries[index])
      .map((state) => state.panel.name);

    if (missingPanels.length > 0) {
      skipped.push({
        subId,
        email,
        reason: `client missing from ${formatPanelList(missingPanels)}`,
        missingPanels
      });
      continue;
    }

    const missingStatsPanels = presentEntries
      .filter((entry) => !entry.stat)
      .map((entry) => entry.panel.name);
    if (missingStatsPanels.length > 0) {
      skipped.push({
        subId,
        email,
        reason: 'client stats missing',
        missingStatsPanels
      });
      continue;
    }

    if (presentEntries.every((entry) => !clientLooksEnabled(entry))) {
      skipped.push({ subId, email, reason: 'already disabled' });
      continue;
    }

    groups.push({ subId, entries: presentEntries });
  }

  const results = await mapLimit(groups, concurrency, (group) => processQuotaGroup(runtime, group, options));
  for (const result of results) {
    if (result.disabled) disabled.push(result.disabled);
    if (result.partialDisabled) partialDisabled.push(result.partialDisabled);
    skipped.push(...result.skipped);
  }

  const result = {
    checked: groups.length,
    disabled,
    partialDisabled,
    skipped
  };

  logger.log(`quota worker checked ${result.checked} clients`);
  logger.log(`disabled clients: ${disabled.length}`);
  logger.log(`partial disabled clients: ${partialDisabled.length}`);
  logger.log(`worker concurrency: ${concurrency}`);
  for (const item of disabled) {
    logger.log(`- ${item.email || item.subId}: ${item.reasons.join(', ')}`);
  }
  for (const item of partialDisabled) {
    const failedPanels = item.failed.map((failure) => failure.panel).filter(Boolean).join(', ');
    logger.log(
      `- partial ${item.email || item.subId}: ${item.reasons.join(', ')}${failedPanels ? `; failed panels: ${failedPanels}` : ''}`
    );
  }
  logger.log(`skipped clients: ${skipped.length}`);

  return result;
}

function parseArgs(argv) {
  const concurrencyArg = argv.find((arg) => arg.startsWith('--concurrency='));
  return {
    dryRun: argv.includes('--dry-run'),
    concurrency: concurrencyArg ? Number.parseInt(concurrencyArg.slice('--concurrency='.length), 10) : undefined
  };
}

async function main() {
  loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const runtime = await createSubscriptionFetcher(config);

  try {
    const result = await enforcePanelQuota(runtime, config.panels, {
      ...options,
      concurrency: options.concurrency || config.worker.concurrency
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
