import {
  buildUpdateClientRequest,
  clientLooksEnabled,
  fetchPanelInbound
} from './quota-worker.js';
import { runPanelMutationsXrayFirst } from './panel-mutations.js';
import { aggregateSubscriptions } from './subscription.js';
import { sourcesForToken } from './source-url.js';
import {
  formatExpiry,
  normalizeCombinedUsage,
  normalizeQuotaUsage,
  summarizeNormalizedUsage,
  usageFromResult
} from './usage.js';

const GIB = 1024 ** 3;

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

function currentUsageEntry(entry) {
  if (!entry.hasCurrentUsage) return entry;

  return {
    ...entry,
    allTime: undefined,
    used: entry.upload + entry.download
  };
}

function panelUsage(entry) {
  const currentEntry = currentUsageEntry(entry);
  const usage = normalizeQuotaUsage(currentEntry);

  return {
    panel: entry.panel.name,
    proxy: entry.panel.proxy,
    email: entry.email,
    enabled: clientLooksEnabled(entry),
    upload: entry.upload,
    download: entry.download,
    used: usage.used,
    total: usage.total,
    remaining: usage.remaining,
    rawTotal: entry.total,
    quotaDivisor: entry.quotaDivisor || 1
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
    const expiryTime = parseExpiryTime(input.expiryTime) ?? parseExpiryDate(input.expiryDate);
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
  const response = await runtime.request(
    {
      name: entry.panel.name,
      proxy: entry.panel.proxy,
      url: request.url
    },
    {
      method: request.method,
      headers: request.headers,
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

async function subscriptionUsage(runtime, sources, subId) {
  const result = await aggregateSubscriptions(sourcesForToken(sources, subId), runtime.fetch);

  return {
    usage: summarizeNormalizedUsage(result.results),
    sources: result.results.map(sourceUsage)
  };
}

export async function listCreatedPanelClients(runtime, panels, options = {}) {
  const configuredSources = options.sources || [];
  const concurrency = options.concurrency || 5;
  const configuredPanels = panels.filter((panel) => panel?.addClientUrl && panel?.inboundId);
  if (configuredPanels.length < 2) {
    throw new Error('At least two configured panels are required to list created clients');
  }

  const panelStates = await Promise.all(
    configuredPanels.map((panel) => fetchPanelInbound(runtime, panel))
  );
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
    let usage = normalizeCombinedUsage(currentEntries);
    let sources = [];
    let usageError = '';

    if (configuredSources.length > 0) {
      try {
        const subscription = await subscriptionUsage(runtime, configuredSources, subId);
        usage = subscription.usage;
        sources = subscription.sources;
      } catch (error) {
        usageError = error.message;
      }
    }

    return {
      subId,
      email: primaryEmail(entries),
      status: statusForEntries(entries),
      enabledPanels: entries.filter(clientLooksEnabled).length,
      totalPanels: entries.length,
      usage,
      usageError,
      sources,
      panels: entries.map(panelUsage)
    };
  });

  clients.sort((first, second) => {
    const firstKey = `${first.email || ''}\u0000${first.subId}`;
    const secondKey = `${second.email || ''}\u0000${second.subId}`;
    return firstKey.localeCompare(secondKey);
  });

  return {
    panels: panelStates.map((state) => ({
      name: state.panel.name,
      inboundId: state.panel.inboundId,
      proxy: state.panel.proxy,
      quotaDivisor: state.panel.quotaDivisor || 1
    })),
    clients
  };
}

export async function updateCreatedPanelClient(runtime, panels, input) {
  if (!input.subId) throw new Error('subId is required');

  const configuredPanels = panels.filter((panel) => panel?.addClientUrl && panel?.inboundId);
  if (configuredPanels.length < 2) {
    throw new Error('At least two configured panels are required to update clients');
  }

  const panelStates = await Promise.all(
    configuredPanels.map((panel) => fetchPanelInbound(runtime, panel))
  );
  const entries = panelStates.map((state) => state.clients.get(input.subId));
  const missingPanels = panelStates
    .filter((state, index) => !entries[index])
    .map((state) => state.panel.name);

  if (missingPanels.length > 0) {
    throw new Error(`Client ${input.subId} is missing from ${missingPanels.join(', ')}`);
  }

  const plannedUpdates = entries.map((entry) => ({
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
