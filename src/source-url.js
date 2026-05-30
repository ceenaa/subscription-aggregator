function trimTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

function validateToken(token) {
  if (!token) {
    throw new Error('Subscription token is required');
  }

  if (token.includes('/') || token.includes('\\')) {
    throw new Error('Subscription token must be a single path segment');
  }
}

export function buildSourceUrl(baseUrl, token) {
  validateToken(token);
  return `${trimTrailingSlashes(baseUrl)}/${encodeURIComponent(token)}`;
}

export function sourcesForToken(sources, token) {
  return sources.map((source) => ({
    ...source,
    url: buildSourceUrl(source.baseUrl, token)
  }));
}
