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

function quotaDivisor(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
}

function totalGbRatio(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function normalizeQuotaUsage(usage, options = {}) {
  const divisor = quotaDivisor(
    options.quotaDivisor ?? usage.quotaDivisor ?? usage.configCount ?? usage.count
  );
  const total = Math.round(numberOrZero(usage.total) / divisor);
  const used = numberOrZero(
    usage.allTime ?? usage.used ?? numberOrZero(usage.upload) + numberOrZero(usage.download)
  );

  if (usage.hasData === false) return usage;

  return {
    ...usage,
    used,
    total,
    remaining: total > 0 ? Math.max(total - used, 0) : 0
  };
}

export function usageFromResult(result) {
  return normalizeQuotaUsage(parseSubscriptionUserInfo(result.headers?.['subscription-userinfo']), {
    quotaDivisor: result.count
  });
}

function baseRatioUsageFromResult(result) {
  const usage = usageFromResult(result);
  if (usage.hasData === false) return usage;

  const ratio = totalGbRatio(result.source?.totalGbRatio);
  const upload = numberOrZero(usage.upload) * ratio;
  const download = numberOrZero(usage.download) * ratio;
  const used = numberOrZero(usage.used) * ratio;
  const total = numberOrZero(usage.total) * ratio;

  return {
    ...usage,
    upload,
    download,
    used,
    total,
    remaining: total > 0 ? Math.max(total - used, 0) : 0,
    totalGbRatio: 1
  };
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
  const normalizedEntries = entries.map((entry) => normalizeQuotaUsage(entry));

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

  const higher = normalizedEntries.reduce(
    (highest, entry) => (entry.total > highest.total ? entry : highest),
    normalizedEntries[0]
  );
  const scales = normalizedEntries.map((entry) => higher.total / entry.total);
  const used = normalizedEntries.reduce(
    (sum, entry, index) => sum + entry.used * scales[index],
    0
  );

  return {
    total: higher.total,
    used,
    remaining: Math.max(higher.total - used, 0),
    scale: Math.max(...scales),
    scales,
    hasData: true
  };
}

export function summarizeNormalizedUsage(results) {
  const usages = results.map(baseRatioUsageFromResult);
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
