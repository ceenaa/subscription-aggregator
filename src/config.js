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

export function loadConfig(env = process.env) {
  return {
    port: readIntegerEnv(env, 'PORT'),
    requestTimeoutMs: readIntegerEnv(env, 'REQUEST_TIMEOUT_MS'),
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
