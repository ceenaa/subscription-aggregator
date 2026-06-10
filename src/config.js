import {
  loadDatabaseConfiguration,
  readLegacySourceConfigs,
  resolveDatabasePath
} from './config-store.js';

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

function sourceKey(source) {
  return `${source.baseUrl || ''}\u0000${source.proxy || ''}`;
}

function mergeSources(databaseSources, envSources) {
  const merged = [...databaseSources];
  const seen = new Set(databaseSources.map(sourceKey));

  for (const source of envSources) {
    const key = sourceKey(source);
    if (seen.has(key)) continue;

    seen.add(key);
    merged.push(source);
  }

  return merged;
}

function databasePathForConfig(env, options) {
  if (options.databasePath) return options.databasePath;
  if (env.SQLITE_DB_PATH) return env.SQLITE_DB_PATH;
  if (env.DATABASE_PATH) return env.DATABASE_PATH;
  return env === process.env ? undefined : ':memory:';
}

export function loadConfig(env = process.env, options = {}) {
  const httpsEnabled = readBooleanEnv(env, 'HTTPS_ENABLED', false);
  const databaseEnabled = options.database !== false;
  const databasePath = resolveDatabasePath(databasePathForConfig(env, options));
  const databaseConfig = databaseEnabled
    ? loadDatabaseConfiguration({ databasePath, legacyEnv: env })
    : { panels: [], sources: [] };
  const envSources = readLegacySourceConfigs(env);

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
    xrayBin: env.XRAY_BIN || 'xray',
    xrayOutboundLink: env.XRAY_OUTBOUND_LINK || '',
    database: {
      enabled: databaseEnabled,
      path: databasePath
    },
    envSources,
    sources: mergeSources(databaseConfig.sources, envSources),
    panels: databaseConfig.panels
  };
}

export function refreshConfiguredTargets(config, env = process.env) {
  if (!config.database?.enabled) return config;

  const databaseConfig = loadDatabaseConfiguration({
    databasePath: config.database.path,
    legacyEnv: env
  });

  config.panels = databaseConfig.panels;
  config.sources = mergeSources(databaseConfig.sources, config.envSources || []);
  return config;
}
