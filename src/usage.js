function normalizeHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  return value || '';
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseSubscriptionUserInfo(value) {
  const fields = {};

  for (const part of normalizeHeaderValue(value).split(';')) {
    const [key, rawValue] = part.split('=').map((entry) => entry?.trim());
    if (!key || rawValue === undefined) continue;

    const parsed = Number.parseInt(rawValue, 10);
    if (Number.isFinite(parsed)) fields[key.toLowerCase()] = parsed;
  }

  const upload = fields.upload ?? 0;
  const download = fields.download ?? 0;
  const total = fields.total ?? 0;
  const used = upload + download;
  const remaining = total > 0 ? Math.max(total - used, 0) : 0;

  return {
    upload,
    download,
    used,
    total,
    remaining,
    expire: fields.expire ?? 0,
    hasData: Object.keys(fields).length > 0
  };
}

function normalizeUsageByLinkCount(usage, linkCount) {
  const count = Number.parseInt(linkCount, 10);
  if (!usage.hasData || !Number.isFinite(count) || count <= 1) return usage;

  const upload = Math.round(usage.upload / count);
  const download = Math.round(usage.download / count);
  const total = Math.round(usage.total / count);
  const used = upload + download;

  return {
    ...usage,
    upload,
    download,
    used,
    total,
    remaining: total > 0 ? Math.max(total - used, 0) : 0
  };
}

export function usageFromResult(result) {
  return normalizeUsageByLinkCount(
    parseSubscriptionUserInfo(result.headers?.['subscription-userinfo']),
    result.count
  );
}

export function summarizeUsage(results) {
  return results.reduce(
    (summary, result) => {
      const usage = usageFromResult(result);
      if (!usage.hasData) return summary;

      summary.upload += usage.upload;
      summary.download += usage.download;
      summary.total += usage.total;
      summary.used += usage.used;
      summary.remaining += usage.remaining;
      return summary;
    },
    {
      upload: 0,
      download: 0,
      used: 0,
      total: 0,
      remaining: 0
    }
  );
}

export function normalizeCombinedUsage(entries) {
  const normalizedEntries = entries.map((entry) => ({
    total: numberOrZero(entry.total),
    used: numberOrZero(entry.allTime ?? entry.used)
  }));

  if (
    normalizedEntries.length === 0 ||
    normalizedEntries.some((entry) => entry.total <= 0)
  ) {
    return {
      total: 0,
      used: 0,
      remaining: 0,
      scale: 0,
      scales: [],
      hasData: false
    };
  }

  const lower = normalizedEntries.reduce(
    (lowest, entry) => (entry.total < lowest.total ? entry : lowest),
    normalizedEntries[0]
  );
  const scales = normalizedEntries.map((entry) => entry.total / lower.total);
  const used = normalizedEntries.reduce(
    (sum, entry, index) => sum + entry.used / scales[index],
    0
  );

  return {
    total: lower.total,
    used,
    remaining: Math.max(lower.total - used, 0),
    scale: Math.max(...scales),
    scales,
    hasData: true
  };
}

export function summarizeNormalizedUsage(results) {
  const usages = results.map(usageFromResult);
  if (usages.length === 0 || usages.some((usage) => !usage.hasData)) {
    return {
      upload: 0,
      download: 0,
      used: 0,
      total: 0,
      remaining: 0,
      scale: 0,
      scales: [],
      hasData: false
    };
  }

  const combined = normalizeCombinedUsage(usages);
  return {
    ...combined,
    upload: 0,
    download: combined.used
  };
}

export function formatSubscriptionUserInfo(usage) {
  const upload = Math.max(0, Math.round(numberOrZero(usage.upload)));
  const download = Math.max(0, Math.round(numberOrZero(usage.download ?? usage.used)));
  const total = Math.max(0, Math.round(numberOrZero(usage.total)));

  return `upload=${upload}; download=${download}; total=${total}; expire=0`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

export function formatExpiry(unixSeconds) {
  if (!unixSeconds) return 'No expiry';
  return new Date(unixSeconds * 1000).toLocaleString('en-US');
}
