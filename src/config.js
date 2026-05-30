function readRequiredEnv(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required. Add it to .env or export it before running.`);
  }

  return value;
}

function readIntegerEnv(env, name) {
  const value = readRequiredEnv(env, name);

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readOptionalIntegerEnv(env, name, fallback) {
  const value = env[name];
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readBooleanEnv(env, name, fallback = false) {
  const value = env[name];
  if (value === undefined || value === '') return fallback;

  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;

  throw new Error(`${name} must be true or false`);
}

function readCsvEnv(env, name) {
  return (env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const httpsEnabled = readBooleanEnv(env, 'HTTPS_ENABLED', false);

  return {
    port: readIntegerEnv(env, 'PORT'),
    host: env.HOST || '127.0.0.1',
    requestTimeoutMs: readIntegerEnv(env, 'REQUEST_TIMEOUT_MS'),
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    trustProxy: readBooleanEnv(env, 'TRUST_PROXY', false),
    https: {
      enabled: httpsEnabled,
      keyPath: httpsEnabled ? readRequiredEnv(env, 'HTTPS_KEY_PATH') : env.HTTPS_KEY_PATH || '',
      certPath: httpsEnabled ? readRequiredEnv(env, 'HTTPS_CERT_PATH') : env.HTTPS_CERT_PATH || '',
      caPath: env.HTTPS_CA_PATH || '',
      hstsEnabled: readBooleanEnv(env, 'HTTPS_HSTS_ENABLED', httpsEnabled),
      hstsMaxAge: readOptionalIntegerEnv(env, 'HTTPS_HSTS_MAX_AGE', 15552000)
    },
    cors: {
      origins: readCsvEnv(env, 'CORS_ORIGIN')
    },
    xrayBin: readRequiredEnv(env, 'XRAY_BIN'),
    xrayOutboundLink: readRequiredEnv(env, 'XRAY_OUTBOUND_LINK'),
    sources: [
      {
        name: env.FIRST_SUBSCRIPTION_NAME || 'wcloud',
        baseUrl: readRequiredEnv(env, 'FIRST_SUBSCRIPTION_BASE_URL'),
        proxy: env.FIRST_SUBSCRIPTION_PROXY || 'xray'
      },
      {
        name: env.SECOND_SUBSCRIPTION_NAME || 'nimcloud',
        baseUrl: readRequiredEnv(env, 'SECOND_SUBSCRIPTION_BASE_URL'),
        proxy: env.SECOND_SUBSCRIPTION_PROXY || 'direct'
      }
    ]
  };
}
