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
