const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};

function appendVary(headers, value) {
  if (!headers.Vary) {
    headers.Vary = value;
    return;
  }

  const existing = new Set(
    headers.Vary.split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );

  if (!existing.has(value.toLowerCase())) {
    headers.Vary = `${headers.Vary}, ${value}`;
  }
}

export function resolveCorsOrigin(config, request) {
  const origin = request.headers.origin;
  const allowedOrigins = config.cors?.origins || [];

  if (!origin || allowedOrigins.length === 0) return '';
  if (allowedOrigins.includes('*')) return '*';
  if (allowedOrigins.includes(origin)) return origin;

  return '';
}

export function buildResponseHeaders(config, request, contentType, extra = {}) {
  const headers = {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...extra
  };

  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  const corsOrigin = resolveCorsOrigin(config, request);
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
    headers['Access-Control-Allow-Methods'] = 'GET, HEAD, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Accept, Content-Type';
    headers['Access-Control-Expose-Headers'] = 'Subscription-Userinfo';
    appendVary(headers, 'Origin');
  }

  if (config.https?.hstsEnabled) {
    headers['Strict-Transport-Security'] = `max-age=${config.https.hstsMaxAge}; includeSubDomains`;
  }

  appendVary(headers, 'Accept');

  return headers;
}
