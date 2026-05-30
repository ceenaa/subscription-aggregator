function forwardedValue(value) {
  if (Array.isArray(value)) return value[0]?.split(',')[0]?.trim();
  return value?.split(',')[0]?.trim();
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

export function getRequestOrigin(config, request) {
  if (config.publicBaseUrl) return trimTrailingSlash(config.publicBaseUrl);

  const host =
    (config.trustProxy && forwardedValue(request.headers['x-forwarded-host'])) ||
    request.headers.host ||
    `127.0.0.1:${config.port}`;

  const protocol =
    (config.trustProxy && forwardedValue(request.headers['x-forwarded-proto'])) ||
    (request.socket.encrypted ? 'https' : 'http');

  return `${protocol}://${host}`;
}

export function getRequestUrl(config, request) {
  return new URL(request.url || '/', getRequestOrigin(config, request));
}

export function absoluteSubscriptionUrl(config, request, token) {
  return `${getRequestOrigin(config, request)}/sub/${encodeURIComponent(token)}`;
}
