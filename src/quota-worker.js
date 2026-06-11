import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import { createSubscriptionFetcher } from './runtime.js';
import { normalizeCombinedUsage, normalizeQuotaUsage } from './usage.js';
import { runPanelMutationsXrayFirst } from './panel-mutations.js';

function requirePanelField(panel, field) {
  if (!panel[field]) {
    throw new Error(`${panel.name} panel is missing ${field}`);
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

export function clientLooksEnabled(entry) {
  if (entry.client && entry.client.enable !== undefined) {
    return isEnabledValue(entry.client.enable);
  }

  return isEnabledValue(entry.stat?.enable);
}

function formatPanelList(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function workerConcurrency(value) {
  return Math.max(1, Number.parseInt(value, 10) || 5);
}

function skippedReason(item) {
  if (item.reason === 'already disabled') return 'already disabled';
  if (item.reason === 'client stats missing') return 'client stats missing';
  if (item.reason === 'client update id missing') return 'client update id missing';
  if (item.reason === 'configured inbound is missing from one or more panels') {
    return 'configured inbound missing';
  }
  if (item.missingPanels) return 'client missing from panel';
  if (item.reason?.startsWith('disable failed:')) return 'disable failed';
  if (item.reason?.startsWith('skipped after Xray failure:')) return 'skipped after Xray failure';
  return item.reason || 'unknown';
}

function countSkippedReasons(skipped) {
  const counts = new Map();
  for (const item of skipped) {
    const reason = skippedReason(item);
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }

  return Array.from(counts.entries()).sort(([first], [second]) => first.localeCompare(second));
}

function countPanelDisables(items) {
  return items.reduce((total, item) => total + item.panels.length, 0);
}

function logQuotaWorkerSummary(logger, result, summary) {
  const durationMs = Math.max(0, Date.now() - summary.startedAt);
  const disabledCount = result.disabled.length;
  const partialDisabledCount = result.partialDisabled.length;
  const unchangedCount = Math.max(0, result.checked - disabledCount - partialDisabledCount);
  const panelDisableCount = countPanelDisables(result.disabled) + countPanelDisables(result.partialDisabled);

  logger.log(`quota worker runtime: ${durationMs}ms`);
  logger.log(`discovered clients: ${summary.discoveredClients}`);
  logger.log(`processed clients: ${result.checked}`);
  logger.log(`disabled clients: ${disabledCount}`);
  logger.log(`partial disabled clients: ${partialDisabledCount}`);
  logger.log(`unchanged clients: ${unchangedCount}`);
  logger.log(`skipped clients: ${result.skipped.length}`);
  logger.log(`panel disable operations: ${panelDisableCount}`);
  logger.log(`worker concurrency: ${summary.concurrency}`);

  if (summary.dryRun) {
    logger.log('dry run: true');
  }

  for (const [reason, count] of countSkippedReasons(result.skipped)) {
    logger.log(`skipped ${reason}: ${count}`);
  }
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

export function buildUpdateClientRequest(panel, inbound, client, stat = null, updates = { enable: false }) {
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
            ...updates
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
    const hasCurrentUsage = stat && ('up' in stat || 'down' in stat);
    const upload = numberOrZero(stat?.up);
    const download = numberOrZero(stat?.down);
    clients.set(subId, {
      panel,
      inbound,
      client,
      stat,
      subId,
      email: client.email || stat?.email || '',
      total: numberOrZero(stat?.total ?? client.totalGB),
      upload,
      download,
      hasCurrentUsage,
      allTime: numberOrZero(stat?.allTime ?? upload + download),
      quotaDivisor: numberOrZero(panel.quotaDivisor) || 1
    });
  }

  return clients;
}

function currentUsageEntry(entry) {
  if (!entry.hasCurrentUsage) return entry;

  return {
    ...entry,
    allTime: undefined,
    used: entry.upload + entry.download
  };
}

export function evaluateQuotaGroup(entries) {
  const currentEntries = entries.map(currentUsageEntry);
  const reasons = [];

  for (const entry of currentEntries) {
    const usage = normalizeQuotaUsage(entry);
    if (usage.total > 0 && usage.used >= usage.total) {
      reasons.push(`${entry.panel.name} quota exceeded`);
    }
  }

  const combined = normalizeCombinedUsage(currentEntries);

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

export async function fetchPanelInbound(runtime, panel) {
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
  const verifiedState = await fetchPanelInbound(runtime, entry.panel);
  if (!verifiedState.inbound) {
    throw new Error(`${entry.panel.name} inbound ${entry.panel.inboundId} missing after update`);
  }

  const verifiedEntry = verifiedState.clients.get(entry.subId);
  if (!verifiedEntry) {
    throw new Error(`${entry.panel.name} client ${entry.subId} missing after update`);
  }

  if (clientLooksEnabled(verifiedEntry)) {
    throw new Error(`${entry.panel.name} client ${entry.subId} still active after update`);
  }

  return {
    panel: entry.panel.name,
    subId: entry.subId,
    email: entry.email,
    response: payload.msg || 'updated'
  };
}

function alreadyDisabledPanel(entry) {
  return {
    panel: entry.panel.name,
    subId: entry.subId,
    email: entry.email,
    response: 'already disabled'
  };
}

async function processQuotaGroup(runtime, group, options) {
  const { entries } = group;
  const dryRun = options.dryRun === true;
  const disableRetries = Number.isInteger(options.disableRetries) ? options.disableRetries : 3;
  const skipped = [];
  const evaluation = evaluateQuotaGroup(entries);
  if (!evaluation.exceeded) return { disabled: null, partialDisabled: null, skipped };

  const targets = entries.filter(clientLooksEnabled);
  const retryableTargets = targets.filter((target) => {
    if (updateClientId(target.client, target.stat)) return true;

    skipped.push({
      subId: target.subId,
      email: target.email,
      panel: target.panel.name,
      reason: 'client update id missing'
    });
    return false;
  });
  const updates = await runPanelMutationsXrayFirst(
    retryableTargets,
    async (target) => {
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
    },
    {
      panelFor: (target) => target.panel,
      onError: (target, error) => ({
        skipped: {
          subId: target.subId,
          email: target.email,
          panel: target.panel.name,
          reason: `disable failed: ${error.message}`
        }
      }),
      onSkipped: (target, error) => ({
        skipped: {
          subId: target.subId,
          email: target.email,
          panel: target.panel.name,
          reason: `skipped after Xray failure: ${error.message}`
        }
      }),
      retries: disableRetries
    }
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
    panels: panelUpdates,
    alreadyDisabledPanels: entries
      .filter((entry) => !clientLooksEnabled(entry))
      .map(alreadyDisabledPanel)
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
  const startedAt = Date.now();
  const concurrency = workerConcurrency(options.concurrency);
  const configuredPanels = panels.filter(Boolean);
  if (configuredPanels.length < 1) {
    throw new Error('At least one configured panel inbound is required before running the quota worker');
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
    logQuotaWorkerSummary(logger, result, {
      concurrency,
      discoveredClients: 0,
      dryRun: options.dryRun === true,
      startedAt
    });
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

  logQuotaWorkerSummary(logger, result, {
    concurrency,
    discoveredClients: allSubIds.size,
    dryRun: options.dryRun === true,
    startedAt
  });

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
    await enforcePanelQuota(runtime, config.panels, {
      ...options,
      concurrency: options.concurrency || config.worker.concurrency
    });
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
