import { timingSafeEqual } from 'node:crypto';

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuth(header) {
  if (!header?.startsWith('Basic ')) return null;

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;

  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1)
  };
}

export function isAdminAuthEnabled(config) {
  return Boolean(config.admin?.username && config.admin?.password);
}

export function isAuthorized(config, request) {
  if (!isAdminAuthEnabled(config)) return true;

  const credentials = parseBasicAuth(request.headers.authorization);
  if (!credentials) return false;

  return (
    safeEqual(credentials.username, config.admin.username) &&
    safeEqual(credentials.password, config.admin.password)
  );
}

export function isAdminAuthorized(config, request) {
  return isAdminAuthEnabled(config) && isAuthorized(config, request);
}
