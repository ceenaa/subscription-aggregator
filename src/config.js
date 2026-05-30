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

function readOptionalNumberEnv(env, name, fallback) {
  const value = env[name];
  if (!value) return fallback;

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
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

function hasPanelConfig(env, prefix) {
  return [
    'NAME',
    'ADD_CLIENT_URL',
    'COOKIE',
    'INBOUND_ID',
    'PROXY',
    'TOTAL_GB_RATIO'
  ].some((field) => env[`${prefix}_PANEL_${field}`] !== undefined);
}

function readPanelConfig(env, prefix, defaults) {
  return {
    name: env[`${prefix}_PANEL_NAME`] || defaults.name,
    addClientUrl: env[`${prefix}_PANEL_ADD_CLIENT_URL`] || '',
    cookie: env[`${prefix}_PANEL_COOKIE`] || '',
    inboundId: env[`${prefix}_PANEL_INBOUND_ID`] || '',
    proxy: env[`${prefix}_PANEL_PROXY`] || defaults.proxy,
    totalGbRatio: readOptionalNumberEnv(env, `${prefix}_PANEL_TOTAL_GB_RATIO`, 1)
  };
}

export function loadConfig(env = process.env) {
  const httpsEnabled = readBooleanEnv(env, 'HTTPS_ENABLED', false);
  const panels = [
    readPanelConfig(env, 'FIRST', { name: 'first', proxy: 'xray' }),
    readPanelConfig(env, 'SECOND', { name: 'second', proxy: 'direct' })
  ];

  if (hasPanelConfig(env, 'THIRD')) {
    panels.push(readPanelConfig(env, 'THIRD', { name: 'third', proxy: 'direct' }));
  }

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
    worker: {
      concurrency: readOptionalIntegerEnv(env, 'WORKER_CONCURRENCY', 5)
    },
    admin: {
      username: env.ADMIN_USERNAME || '',
      password: env.ADMIN_PASSWORD || ''
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
    ],
    panels
  };
}
