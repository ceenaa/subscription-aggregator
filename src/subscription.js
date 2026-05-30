const SUBSCRIPTION_LINK_PROTOCOLS = new Set([
  'vless',
  'vmess',
  'trojan',
  'ss',
  'ssr',
  'hysteria',
  'hysteria2',
  'hy2',
  'tuic',
  'wireguard'
]);

function hasSubscriptionLink(text) {
  return text
    .split(/\r?\n/)
    .some((line) => isSubscriptionLink(line.trim()));
}

function isProbablyBase64(text) {
  const compact = text.replace(/\s+/g, '');
  return compact.length > 0 && /^[A-Za-z0-9+/=_-]+$/.test(compact);
}

function toPaddedBase64(text) {
  const normalized = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  return remainder === 0 ? normalized : normalized + '='.repeat(4 - remainder);
}

function toBase64Url(text) {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function formatNoticeTime(updatedAt) {
  const date = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);

  if (Number.isNaN(date.getTime())) {
    return 'unknown time';
  }

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} Tehran`;
}

function decodeLinkName(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatQuotaRatio(value) {
  const parsed = Number.parseFloat(value ?? 1);
  return Number.isFinite(parsed) ? parsed.toString() : '1';
}

function appendLabelSuffix(label, suffix) {
  const trimmedLabel = label.trim();
  return trimmedLabel ? `${trimmedLabel} - ${suffix}` : suffix;
}

function appendUriFragmentSuffix(link, suffix) {
  const hashIndex = link.indexOf('#');
  const base = hashIndex === -1 ? link : link.slice(0, hashIndex);
  const label = hashIndex === -1 ? '' : decodeLinkName(link.slice(hashIndex + 1));

  return `${base}#${encodeURIComponent(appendLabelSuffix(label, suffix))}`;
}

function appendVmessLabelSuffix(link, suffix) {
  const protocol = 'vmess://';
  const payload = link.slice(protocol.length);
  const hashIndex = payload.indexOf('#');
  const encodedConfig = hashIndex === -1 ? payload : payload.slice(0, hashIndex);

  try {
    const config = JSON.parse(Buffer.from(toPaddedBase64(encodedConfig), 'base64').toString('utf8'));
    config.ps = appendLabelSuffix(config.ps || '', suffix);
    return `${protocol}${Buffer.from(JSON.stringify(config), 'utf8').toString('base64')}`;
  } catch {
    return appendUriFragmentSuffix(link, suffix);
  }
}

export function isSubscriptionLink(line) {
  const separatorIndex = line.indexOf('://');
  if (separatorIndex <= 0) return false;

  const protocol = line.slice(0, separatorIndex).toLowerCase();
  return SUBSCRIPTION_LINK_PROTOCOLS.has(protocol);
}

export function decodeSubscriptionText(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const trimmed = text.trim();

  if (!trimmed || !isProbablyBase64(trimmed)) {
    return text;
  }

  const decoded = Buffer.from(toPaddedBase64(trimmed), 'base64').toString('utf8');
  return hasSubscriptionLink(decoded) ? decoded : text;
}

export function extractSubscriptionLinks(input) {
  return decodeSubscriptionText(input)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter(isSubscriptionLink);
}

export function encodeSubscriptionLinks(links) {
  return Buffer.from(`${links.join('\n')}\n`, 'utf8').toString('base64');
}

export function formatPlainSubscription(links) {
  return `${links.join('\n')}\n`;
}

export function buildSubscriptionNoticeLink(updatedAt = new Date()) {
  const userInfo = toBase64Url('aes-128-gcm:subscription-notice-updated-at');
  const label = `آخرین بروزرسانی: ${formatNoticeTime(updatedAt)}`;

  return `ss://${userInfo}@127.0.0.1:1#${encodeURIComponent(label)}`;
}

export function buildSubscriptionNoticeLinks(updatedAt = new Date()) {
  const dailyUpdateUserInfo = toBase64Url('aes-128-gcm:subscription-notice-daily-update');

  return [
    buildSubscriptionNoticeLink(updatedAt),
    `ss://${dailyUpdateUserInfo}@127.0.0.1:2#${encodeURIComponent('لینک اشتراک را روزانه بروزرسانی کنید')}`
  ];
}

export function withSubscriptionNotice(links, updatedAt = new Date()) {
  return [...links, ...buildSubscriptionNoticeLinks(updatedAt)];
}

export function appendSubscriptionLinkNameSuffix(link, suffix) {
  if (link.toLowerCase().startsWith('vmess://')) {
    return appendVmessLabelSuffix(link, suffix);
  }

  return appendUriFragmentSuffix(link, suffix);
}

export function linksWithPanelRatioNames(results, panels = []) {
  const seen = new Set();
  const links = [];

  results.forEach((result, index) => {
    const ratio = panels[index]?.totalGbRatio ?? result.source?.totalGbRatio ?? 1;
    const suffix = `مصرف با ضریب ${formatQuotaRatio(ratio)}`;

    for (const link of result.links) {
      const namedLink = appendSubscriptionLinkNameSuffix(link, suffix);
      if (seen.has(namedLink)) continue;

      seen.add(namedLink);
      links.push(namedLink);
    }
  });

  return links;
}

export async function aggregateSubscriptions(sources, fetchSource) {
  const results = await Promise.all(
    sources.map(async (source) => {
      let fetched;
      try {
        fetched = await fetchSource(source);
      } catch (error) {
        throw new Error(
          `Failed to fetch source "${source.name}" via ${source.proxy}: ${error.message}`
        );
      }

      const body =
        fetched && typeof fetched === 'object' && 'body' in fetched ? fetched.body : fetched;
      const headers =
        fetched && typeof fetched === 'object' && 'headers' in fetched ? fetched.headers : {};
      const links = extractSubscriptionLinks(body);

      return {
        source,
        headers,
        links,
        count: links.length
      };
    })
  );

  const seen = new Set();
  const links = [];

  for (const result of results) {
    for (const link of result.links) {
      if (seen.has(link)) continue;

      seen.add(link);
      links.push(link);
    }
  }

  return {
    links,
    encoded: encodeSubscriptionLinks(links),
    results
  };
}
