function normalizeHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  return value || '';
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

export function usageFromResult(result) {
  return parseSubscriptionUserInfo(result.headers?.['subscription-userinfo']);
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

export function formatSubscriptionUserInfo(usage) {
  return `upload=${usage.upload}; download=${usage.download}; total=${usage.total}; expire=0`;
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
