import {
  buildUpdateClientRequest,
  clientLooksEnabled,
  fetchPanelCsrfToken,
  fetchPanelInbounds,
  fetchPanelOnlineClients,
  indexInboundClients
} from './quota-worker.js';
import { runPanelMutationsXrayFirst } from './panel-mutations.js';
import { aggregateSubscriptions } from './subscription.js';
import { sourcesForToken } from './source-url.js';
import {
  deduplicateUsageEntries,
  formatExpiry,
  normalizeCombinedUsage,
  normalizeQuotaUsage,
  summarizeNormalizedUsage,
  usageFromResult
} from './usage.js';

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function statusForEntries(entries) {
  const enabledCount = entries.filter(clientLooksEnabled).length;

  if (enabledCount === entries.length) return 'Active';
  if (enabledCount === 0) return 'Inactive';
  return 'Partial';
}

function primaryEmail(entries) {
  return entries.find((entry) => entry.email)?.email || '';
}

function legacySuffixBase(email) {
  return String(email || '').replace(/-\d+$/, '');
}

function displayEmail(entries) {
  const emails = uniqueStrings(entries.map((entry) => entry.email));
  if (emails.length <= 1) return emails[0] || '';

  const bases = uniqueStrings(emails.map(legacySuffixBase));
  if (bases.length === 1 && bases[0]) return bases[0];

  return emails.join(', ');
}

function currentUsageEntry(entry) {
  if (!entry.hasCurrentUsage) return entry;

  return {
    ...entry,
    allTime: undefined,
    used: entry.upload + entry.download
  };
}

function panelUsage(entries) {
  const panelEntries = Array.isArray(entries) ? entries : [entries];
  const firstEntry = panelEntries[0];
  const usageEntries = deduplicateUsageEntries(
    panelEntries.map(currentUsageEntry),
    (entry) => panelGroupKey(entry.panel)
  );
  const currentEntry = usageEntries[0] || currentUsageEntry(firstEntry);
  const usage = normalizeQuotaUsage(currentEntry);
  const status = panelEntries.some(clientLooksEnabled) ? 'Active' : 'Inactive';
  const quotaDivisors = uniqueStrings(panelEntries.map((entry) => entry.quotaDivisor || 1));
  const proxies = uniqueStrings(panelEntries.map((entry) => entry.panel.proxy));

  return {
    panel: firstEntry.panel.panelName || firstEntry.panel.name,
    proxy: proxies.join(', '),
    email: displayEmail(panelEntries),
    status,
    enabled: status === 'Active',
    upload: currentEntry.upload,
    download: currentEntry.download,
    used: usage.used,
    total: usage.total,
    remaining: usage.remaining,
    rawTotal: currentEntry.total,
    quotaDivisor: quotaDivisors.join(', ')
  };
}

function sourceUsage(result) {
  const usage = usageFromResult(result);

  return {
    source: result.source.name,
    proxy: result.source.proxy,
    links: result.count,
    upload: usage.upload,
    download: usage.download,
    used: usage.used,
    total: usage.total,
    remaining: usage.remaining,
    expire: usage.expire,
    expiry: formatExpiry(usage.expire),
    hasData: usage.hasData
  };
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function panelApiIdentity(panel) {
  try {
    const url = new URL(panel.addClientUrl);
    const root = url.pathname
      .replace(/\/api\/inbounds\/addClient\/?$/, '')
      .replace(/\/api\/clients\/add\/?$/, '');
    return `${url.origin}${root}/api\u0000${panel.proxy || ''}`;
  } catch {
    return `${panel.addClientUrl || ''}\u0000${panel.proxy || ''}`;
  }
}

function panelListKey(panel) {
  return `${panelApiIdentity(panel)}\u0000${panel.cookie || ''}`;
}

function panelGroupKey(panel) {
  if (panel.panelDbId !== undefined && panel.panelDbId !== null) {
    return `db:${panel.panelDbId}`;
  }

  return panelApiIdentity(panel);
}

function panelClientMutationKey(entry) {
  const email = entry.client?.email || entry.stat?.email || entry.email || '';
  if (!email) return '';
  return `${panelGroupKey(entry.panel)}\u0000${email}`;
}

function deduplicatePanelClientMutationEntries(entries) {
  const deduplicated = [];
  const seen = new Set();

  for (const entry of entries) {
    const key = panelClientMutationKey(entry);
    if (!key) {
      deduplicated.push(entry);
      continue;
    }
    if (seen.has(key)) continue;

    seen.add(key);
    deduplicated.push(entry);
  }

  return deduplicated;
}

function groupByPanel(items, getPanel = (item) => item) {
  const groups = [];
  const groupsByKey = new Map();

  for (const item of items) {
    const panel = getPanel(item);
    const key = panelGroupKey(panel);
    let group = groupsByKey.get(key);

    if (!group) {
      group = { key, items: [] };
      groupsByKey.set(key, group);
      groups.push(group);
    }

    group.items.push(item);
  }

  return groups;
}

function panelStateFromInbounds(panel, inbounds) {
  const inbound = inbounds.find((item) => String(item.id) === String(panel.inboundId));

  return {
    panel,
    inbound: inbound || null,
    clients: inbound ? indexInboundClients(panel, inbound) : new Map()
  };
}

async function fetchConfiguredPanelStates(runtime, panels) {
  const inboundsByPanel = new Map();

  for (const panel of panels) {
    const key = panelListKey(panel);
    if (!inboundsByPanel.has(key)) {
      inboundsByPanel.set(key, fetchPanelInbounds(runtime, panel));
    }
  }

  return Promise.all(
    panels.map(async (panel) => panelStateFromInbounds(panel, await inboundsByPanel.get(panelListKey(panel))))
  );
}

async function loadPanelOnlineState(runtime, panel) {
  try {
    const onlineClients = await fetchPanelOnlineClients(runtime, panel);
    return {
      onlineCount: onlineClients.length,
      onlineError: ''
    };
  } catch (error) {
    return {
      onlineCount: null,
      onlineError: error.message
    };
  }
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
    )
  );
}

function panelSummaryState(states, onlineState = {}) {
  const firstPanel = states[0].panel;
  const clients = new Map();

  for (const state of states) {
    for (const entry of state.clients.values()) {
      const key = entry.subId || entry.email || entry.client?.id || `${state.panel.inboundId}:${clients.size}`;
      const client = clients.get(key) || { active: false };
      client.active = client.active || clientLooksEnabled(entry);
      clients.set(key, client);
    }
  }

  const clientStates = Array.from(clients.values());
  const totalClients = clientStates.length;
  const activeClients = clientStates.filter((client) => client.active).length;
  const inboundIds = uniqueStrings(states.map((state) => state.panel.inboundId));
  const quotaDivisors = uniqueStrings(states.map((state) => state.panel.quotaDivisor || 1));
  const proxies = uniqueStrings(states.map((state) => state.panel.proxy));

  return {
    name: firstPanel.panelName || firstPanel.name,
    inboundId: inboundIds[0] || '',
    inboundIds,
    inboundCount: states.length,
    proxy: proxies.join(', '),
    quotaDivisor: quotaDivisors.join(', '),
    quotaDivisors,
    totalClients,
    activeClients,
    inactiveClients: Math.max(totalClients - activeClients, 0),
    onlineCount: onlineState.onlineCount,
    onlineError: onlineState.onlineError || ''
  };
}

function parseAddUsageBytes(value, ratio = 1) {
  if (value === undefined || String(value).trim() === '') return 0;

  const parsed = Number.parseFloat(value);
  const parsedRatio = Number.parseFloat(ratio ?? 1);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('addGB must be zero or a positive number');
  }
  if (!Number.isFinite(parsedRatio) || parsedRatio <= 0) {
    throw new Error('totalGbRatio must be a positive number');
  }

  return Math.round((parsed / parsedRatio) * GIB);
}

function parseExpiryDate(value) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('expiryDate must be a valid date');
  }

  return date.getTime();
}

function parseExpiryTime(value) {
  if (value === undefined || String(value).trim() === '') return null;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('expiryTime must be a valid timestamp');
  }

  return parsed;
}

function parseExpiryAfterDays(value) {
  if (value === undefined || String(value).trim() === '') return null;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('expiryAfterDays must be zero or a positive integer');
  }

  return Date.now() + parsed * DAY_MS;
}

function updateFieldsForEntry(entry, input) {
  const updates = {};

  if (input.status === 'enable') {
    updates.enable = true;
  } else if (input.status === 'disable') {
    updates.enable = false;
  }

  const addedUsage = parseAddUsageBytes(input.addGB, entry.panel.totalGbRatio);
  if (addedUsage > 0) {
    updates.totalGB = numberOrZero(entry.client.totalGB ?? entry.total) + addedUsage;
  }

  if (input.clearExpiry === true) {
    updates.expiryTime = 0;
  } else {
    const expiryTime =
      parseExpiryAfterDays(input.expiryAfterDays) ??
      parseExpiryTime(input.expiryTime) ??
      parseExpiryDate(input.expiryDate);
    if (expiryTime !== null) updates.expiryTime = expiryTime;
  }

  return updates;
}

function hasUpdates(updates) {
  return Object.keys(updates).length > 0;
}

function parsePanelPayload(body, panelName) {
  try {
    const parsed = JSON.parse(body);
    if (parsed?.success === false) {
      throw new Error(parsed.msg || 'unknown panel error');
    }

    return parsed;
  } catch (error) {
    throw new Error(`${panelName} update failed: ${error.message}`);
  }
}

async function updatePanelClient(runtime, entry, updates) {
  const request = buildUpdateClientRequest(entry.panel, entry.inbound, entry.client, entry.stat, updates);
  const headers = { ...request.headers };
  if (entry.panel.cookie) {
    const token = await fetchPanelCsrfToken(runtime, entry.panel);
    if (token) headers['X-CSRF-Token'] = token;
  }
  const response = await runtime.request(
    {
      name: entry.panel.name,
      proxy: entry.panel.proxy,
      url: request.url
    },
    {
      method: request.method,
      headers,
      body: request.body
    }
  );
  const payload = parsePanelPayload(response.body, entry.panel.name);

  return {
    panel: entry.panel.name,
    ok: response.statusCode >= 200 && response.statusCode < 300 && payload?.success !== false,
    response: payload.msg || 'updated',
    updates
  };
}

export async function loadCreatedPanelClientSubscriptionUsage(runtime, sources, subId) {
  const result = await aggregateSubscriptions(sourcesForToken(sources, subId), runtime.fetch);

  return {
    usage: summarizeNormalizedUsage(result.results),
    sources: result.results.map(sourceUsage)
  };
}

export async function listCreatedPanelClients(runtime, panels, options = {}) {
  const configuredSources = options.sources || [];
  const concurrency = options.concurrency || 5;
  const includeSubscriptionUsage = options.includeSubscriptionUsage !== false;
  const configuredPanels = panels.filter((panel) => panel?.addClientUrl && panel?.inboundId);
  if (configuredPanels.length < 1) {
    throw new Error('At least one configured panel inbound is required to list created clients');
  }

  const [panelStates, onlineStates] = await Promise.all([
    fetchConfiguredPanelStates(runtime, configuredPanels),
    Promise.all(
      groupByPanel(configuredPanels).map(async (group) => [
        group.key,
        await loadPanelOnlineState(runtime, group.items[0])
      ])
    )
  ]);
  const onlineStatesByPanel = new Map(onlineStates);
  const missingInboundPanels = panelStates
    .filter((state) => !state.inbound)
    .map((state) => state.panel.name);

  if (missingInboundPanels.length > 0) {
    throw new Error(`Configured inbound is missing from ${missingInboundPanels.join(', ')}`);
  }

  const firstState = panelStates[0];
  const groups = [];

  for (const subId of firstState.clients.keys()) {
    const entries = panelStates.map((state) => state.clients.get(subId));
    if (entries.some((entry) => !entry)) continue;

    groups.push({ subId, entries });
  }

  const clients = await mapLimit(groups, concurrency, async ({ subId, entries }) => {
    const currentEntries = entries.map(currentUsageEntry);
    const usageEntries = deduplicateUsageEntries(
      currentEntries,
      (entry) => panelGroupKey(entry.panel)
    );
    let usage = normalizeCombinedUsage(usageEntries);
    let sources = [];
    let usageError = '';

    if (configuredSources.length > 0) {
      try {
        if (includeSubscriptionUsage) {
          const subscription = await loadCreatedPanelClientSubscriptionUsage(
            runtime,
            configuredSources,
            subId
          );
          usage = subscription.usage;
          sources = subscription.sources;
        }
      } catch (error) {
        usageError = error.message;
      }
    }

    const panelRows = groupByPanel(entries, (entry) => entry.panel).map((group) =>
      panelUsage(group.items)
    );

    return {
      subId,
      email: primaryEmail(entries),
      status: statusForEntries(entries),
      enabledPanels: panelRows.filter((panel) => panel.status === 'Active').length,
      totalPanels: panelRows.length,
      usage,
      usageError,
      sources,
      panels: panelRows
    };
  });

  clients.sort((first, second) => {
    const firstKey = `${first.email || ''}\u0000${first.subId}`;
    const secondKey = `${second.email || ''}\u0000${second.subId}`;
    return firstKey.localeCompare(secondKey);
  });

  return {
    panels: groupByPanel(panelStates, (state) => state.panel).map((group) =>
      panelSummaryState(group.items, onlineStatesByPanel.get(group.key))
    ),
    clients
  };
}

export async function updateCreatedPanelClient(runtime, panels, input) {
  if (!input.subId) throw new Error('subId is required');

  const configuredPanels = panels.filter((panel) => panel?.addClientUrl && panel?.inboundId);
  if (configuredPanels.length < 1) {
    throw new Error('At least one configured panel inbound is required to update clients');
  }

  const panelStates = await fetchConfiguredPanelStates(runtime, configuredPanels);
  const entries = panelStates.map((state) => state.clients.get(input.subId));
  const missingPanels = panelStates
    .filter((state, index) => !entries[index])
    .map((state) => state.panel.name);

  if (missingPanels.length > 0) {
    throw new Error(`Client ${input.subId} is missing from ${missingPanels.join(', ')}`);
  }

  const plannedUpdates = deduplicatePanelClientMutationEntries(entries).map((entry) => ({
    entry,
    updates: updateFieldsForEntry(entry, input)
  }));

  if (plannedUpdates.every((item) => !hasUpdates(item.updates))) {
    throw new Error('No edit fields were provided');
  }

  const results = await runPanelMutationsXrayFirst(
    plannedUpdates,
    async ({ entry, updates }) => {
      if (!hasUpdates(updates)) {
        return {
          panel: entry.panel.name,
          ok: true,
          skipped: true,
          response: 'no changes'
        };
      }

      const result = await updatePanelClient(runtime, entry, updates);
      if (!result.ok) throw new Error(result.response || 'panel update failed');
      return result;
    },
    {
      panelFor: (item) => item.entry.panel,
      onError: ({ entry, updates }, error) => ({
        panel: entry.panel.name,
        ok: false,
        error: error.message,
        updates
      }),
      onSkipped: ({ entry, updates }, error) => ({
        panel: entry.panel.name,
        ok: false,
        skipped: true,
        error: `skipped after Xray failure: ${error.message}`,
        updates
      })
    }
  );

  return {
    subId: input.subId,
    results,
    ok: results.every((result) => result.ok)
  };
}
