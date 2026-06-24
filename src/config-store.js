import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const DEFAULT_DATABASE_PATH = 'data/subscription-aggregator.sqlite3';

const VALID_PROXY_VALUES = new Set(['direct', 'xray']);
const LEGACY_PREFIXES = [
  { prefix: 'FIRST', name: 'first', sourceName: 'wcloud', proxy: 'xray' },
  { prefix: 'SECOND', name: 'second', sourceName: 'nimcloud', proxy: 'direct' },
  { prefix: 'THIRD', name: 'third', sourceName: 'third', proxy: 'direct' }
];

function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch {
    throw new Error('SQLite configuration storage requires Node.js 22.5 or newer.');
  }
}

export function resolveDatabasePath(value, cwd = process.cwd()) {
  const databasePath = value || DEFAULT_DATABASE_PATH;
  if (databasePath === ':memory:') return databasePath;
  return path.isAbsolute(databasePath) ? databasePath : path.resolve(cwd, databasePath);
}

function openDatabase(databasePath) {
  const resolvedPath = resolveDatabasePath(databasePath);
  if (resolvedPath !== ':memory:') {
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA foreign_keys = ON');
  ensureDatabase(db);
  return db;
}

function withDatabase(databasePath, callback) {
  const db = openDatabase(databasePath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function ensureDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      add_client_url TEXT NOT NULL DEFAULT '',
      cookie TEXT NOT NULL DEFAULT '',
      proxy TEXT NOT NULL DEFAULT 'direct',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inbounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      panel_id INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      inbound_id TEXT NOT NULL,
      subscription_name TEXT NOT NULL DEFAULT '',
      subscription_base_url TEXT NOT NULL DEFAULT '',
      subscription_proxy TEXT NOT NULL DEFAULT '',
      total_gb_ratio REAL NOT NULL DEFAULT 1,
      quota_divisor REAL NOT NULL DEFAULT 1,
      xtls_vision_flow INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_inbounds_panel_id ON inbounds(panel_id);
    CREATE INDEX IF NOT EXISTS idx_inbounds_enabled ON inbounds(enabled);
  `);
  ensureColumn(db, 'inbounds', 'xtls_vision_flow', 'xtls_vision_flow INTEGER NOT NULL DEFAULT 0');
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function ensureColumn(db, table, column, definition) {
  if (tableColumns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function getMeta(db, key) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value || '';
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function rowCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
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

function hasLegacyPanelConfig(env, prefix) {
  return [
    'NAME',
    'ADD_CLIENT_URL',
    'COOKIE',
    'INBOUND_ID',
    'PROXY',
    'TOTAL_GB_RATIO',
    'QUOTA_DIVISOR',
    'CONFIG_COUNT'
  ].some((field) => env[`${prefix}_PANEL_${field}`] !== undefined);
}

function normalizeProxy(value, fallback = 'direct', allowEmpty = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized && allowEmpty) return '';
  const proxy = normalized || fallback;
  if (!VALID_PROXY_VALUES.has(proxy)) {
    throw new Error('proxy must be direct or xray');
  }

  return proxy;
}

function readLegacySource(env, prefix, defaults) {
  const baseUrl = env[`${prefix}_SUBSCRIPTION_BASE_URL`] || '';
  if (!baseUrl) return null;

  return {
    name: env[`${prefix}_SUBSCRIPTION_NAME`] || defaults.sourceName,
    baseUrl,
    proxy: normalizeProxy(env[`${prefix}_SUBSCRIPTION_PROXY`], defaults.proxy)
  };
}

export function readLegacySourceConfigs(env = process.env) {
  return LEGACY_PREFIXES.map((defaults) => readLegacySource(env, defaults.prefix, defaults)).filter(Boolean);
}

function readLegacyPanelConfigs(env) {
  return LEGACY_PREFIXES.filter((defaults) => hasLegacyPanelConfig(env, defaults.prefix)).map(
    (defaults) => {
      const configCount = readOptionalNumberEnv(env, `${defaults.prefix}_PANEL_CONFIG_COUNT`, 1);
      const source = readLegacySource(env, defaults.prefix, defaults);

      return {
        name: env[`${defaults.prefix}_PANEL_NAME`] || defaults.name,
        addClientUrl: env[`${defaults.prefix}_PANEL_ADD_CLIENT_URL`] || '',
        cookie: env[`${defaults.prefix}_PANEL_COOKIE`] || '',
        inboundId: env[`${defaults.prefix}_PANEL_INBOUND_ID`] || '',
        proxy: normalizeProxy(env[`${defaults.prefix}_PANEL_PROXY`], defaults.proxy),
        totalGbRatio: readOptionalNumberEnv(env, `${defaults.prefix}_PANEL_TOTAL_GB_RATIO`, 1),
        quotaDivisor: readOptionalNumberEnv(env, `${defaults.prefix}_PANEL_QUOTA_DIVISOR`, configCount),
        subscriptionName: source?.name || '',
        subscriptionBaseUrl: source?.baseUrl || '',
        subscriptionProxy: source?.proxy || ''
      };
    }
  );
}

function legacyPanelKey(panel) {
  return [panel.addClientUrl, panel.cookie, panel.proxy].join('\u0000');
}

function seedLegacyConfiguration(db, env) {
  if (getMeta(db, 'legacy_seeded') === '1') return;

  const legacyPanels = readLegacyPanelConfigs(env);
  if (legacyPanels.length === 0) return;

  if (rowCount(db, 'panels') > 0 || rowCount(db, 'inbounds') > 0) {
    setMeta(db, 'legacy_seeded', '1');
    return;
  }

  const panelIdsByKey = new Map();
  for (const legacyPanel of legacyPanels) {
    const key = legacyPanelKey(legacyPanel);
    let panelId = panelIdsByKey.get(key);

    if (!panelId) {
      const result = db.prepare(`
        INSERT INTO panels (name, add_client_url, cookie, proxy, enabled)
        VALUES (?, ?, ?, ?, 1)
      `).run(
        legacyPanel.name,
        legacyPanel.addClientUrl,
        legacyPanel.cookie,
        legacyPanel.proxy
      );
      panelId = Number(result.lastInsertRowid);
      panelIdsByKey.set(key, panelId);
    }

    db.prepare(`
      INSERT INTO inbounds (
        panel_id,
        name,
        inbound_id,
        subscription_name,
        subscription_base_url,
        subscription_proxy,
        total_gb_ratio,
        quota_divisor,
        enabled,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      panelId,
      legacyPanel.name,
      legacyPanel.inboundId,
      legacyPanel.subscriptionName,
      legacyPanel.subscriptionBaseUrl,
      legacyPanel.subscriptionProxy,
      legacyPanel.totalGbRatio,
      legacyPanel.quotaDivisor,
      Number(panelIdsByKey.size)
    );
  }

  setMeta(db, 'legacy_seeded', '1');
}

function routeName(row) {
  if (row.inboundName) return row.inboundName;
  if (row.inboundId) return `${row.panelName} inbound ${row.inboundId}`;
  return row.panelName;
}

function mapConfiguredInbound(row) {
  return {
    dbId: row.inboundDbId,
    panelDbId: row.panelDbId,
    name: routeName(row),
    panelName: row.panelName,
    inboundName: row.inboundName || '',
    addClientUrl: row.addClientUrl,
    cookie: row.cookie,
    inboundId: row.inboundId,
    proxy: row.proxy,
    totalGbRatio: Number(row.totalGbRatio) || 1,
    quotaDivisor: Number(row.quotaDivisor) || 1,
    clientFlow: row.xtlsVisionFlow ? 'xtls-rprx-vision' : ''
  };
}

function configuredInboundRows(db) {
  return db.prepare(`
    SELECT
      inbounds.id AS inboundDbId,
      panels.id AS panelDbId,
      panels.name AS panelName,
      inbounds.name AS inboundName,
      panels.add_client_url AS addClientUrl,
      panels.cookie AS cookie,
      panels.proxy AS proxy,
      inbounds.inbound_id AS inboundId,
      inbounds.total_gb_ratio AS totalGbRatio,
      inbounds.quota_divisor AS quotaDivisor,
      inbounds.xtls_vision_flow AS xtlsVisionFlow,
      inbounds.subscription_name AS subscriptionName,
      inbounds.subscription_base_url AS subscriptionBaseUrl,
      inbounds.subscription_proxy AS subscriptionProxy
    FROM inbounds
    INNER JOIN panels ON panels.id = inbounds.panel_id
    WHERE panels.enabled = 1 AND inbounds.enabled = 1
    ORDER BY inbounds.sort_order ASC, inbounds.id ASC
  `).all();
}

function listConfiguredPanelInbounds(db) {
  return configuredInboundRows(db).map(mapConfiguredInbound);
}

function listConfiguredSubscriptionSources(db) {
  return configuredInboundRows(db)
    .filter((row) => row.subscriptionBaseUrl)
    .map((row) => {
      const inbound = mapConfiguredInbound(row);
      return {
        name: row.subscriptionName || inbound.name,
        baseUrl: row.subscriptionBaseUrl,
        proxy: row.subscriptionProxy || row.proxy,
        totalGbRatio: inbound.totalGbRatio,
        inboundDbId: row.inboundDbId,
        panelDbId: row.panelDbId
      };
    });
}

export function loadDatabaseConfiguration({ databasePath, legacyEnv = process.env } = {}) {
  return withDatabase(databasePath, (db) => {
    seedLegacyConfiguration(db, legacyEnv);
    return {
      panels: listConfiguredPanelInbounds(db),
      sources: listConfiguredSubscriptionSources(db)
    };
  });
}

function requireText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function optionalText(value) {
  return String(value ?? '').trim();
}

function readPositiveNumber(value, field, fallback = 1) {
  if (value === undefined || value === '') return fallback;

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive number`);
  }

  return parsed;
}

function readPositiveInteger(value, field) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }

  return parsed;
}

function validateUrl(value, field, options = {}) {
  const text = options.required ? requireText(value, field) : optionalText(value);
  if (!text) return '';

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }

  if (options.addClientPath && !/\/api\/(?:inbounds\/addClient|clients\/add)\/?$/.test(url.pathname)) {
    throw new Error(`${field} must end with /api/inbounds/addClient or /api/clients/add`);
  }

  return text;
}

function normalizePanelInput(input) {
  return {
    name: requireText(input.name, 'panel name'),
    addClientUrl: validateUrl(input.addClientUrl, 'add client URL', {
      required: true,
      addClientPath: true
    }),
    cookie: optionalText(input.cookie),
    proxy: normalizeProxy(input.proxy, 'direct'),
    enabled: input.enabled ? 1 : 0
  };
}

function normalizeInboundInput(input) {
  const subscriptionProxy = normalizeProxy(input.subscriptionProxy, '', true);
  return {
    panelId: readPositiveInteger(input.panelId, 'panel'),
    name: optionalText(input.name),
    inboundId: requireText(input.inboundId, 'inbound ID'),
    subscriptionName: optionalText(input.subscriptionName),
    subscriptionBaseUrl: validateUrl(input.subscriptionBaseUrl, 'subscription base URL'),
    subscriptionProxy,
    totalGbRatio: readPositiveNumber(input.totalGbRatio, 'total GB ratio', 1),
    quotaDivisor: readPositiveNumber(input.quotaDivisor, 'quota divisor', 1),
    xtlsVisionFlow: input.xtlsVisionFlow ? 1 : 0,
    enabled: input.enabled ? 1 : 0
  };
}

export function loadSettingsData(databasePath) {
  return withDatabase(databasePath, (db) => ({
    panels: db.prepare(`
      SELECT
        panels.*,
        COUNT(inbounds.id) AS inboundCount
      FROM panels
      LEFT JOIN inbounds ON inbounds.panel_id = panels.id
      GROUP BY panels.id
      ORDER BY panels.id ASC
    `).all(),
    inbounds: db.prepare(`
      SELECT
        inbounds.*,
        panels.name AS panelName
      FROM inbounds
      INNER JOIN panels ON panels.id = inbounds.panel_id
      ORDER BY inbounds.sort_order ASC, inbounds.id ASC
    `).all()
  }));
}

export function createPanel(databasePath, input) {
  const panel = normalizePanelInput(input);
  return withDatabase(databasePath, (db) => {
    const result = db.prepare(`
      INSERT INTO panels (name, add_client_url, cookie, proxy, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(panel.name, panel.addClientUrl, panel.cookie, panel.proxy, panel.enabled);
    return Number(result.lastInsertRowid);
  });
}

export function updatePanel(databasePath, id, input) {
  const panelId = readPositiveInteger(id, 'panel id');
  const panel = normalizePanelInput(input);
  return withDatabase(databasePath, (db) => {
    const result = db.prepare(`
      UPDATE panels
      SET
        name = ?,
        add_client_url = ?,
        cookie = ?,
        proxy = ?,
        enabled = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(panel.name, panel.addClientUrl, panel.cookie, panel.proxy, panel.enabled, panelId);
    if (result.changes === 0) throw new Error('panel not found');
  });
}

export function deletePanel(databasePath, id) {
  const panelId = readPositiveInteger(id, 'panel id');
  return withDatabase(databasePath, (db) => {
    const result = db.prepare('DELETE FROM panels WHERE id = ?').run(panelId);
    if (result.changes === 0) throw new Error('panel not found');
  });
}

export function createInbound(databasePath, input) {
  const inbound = normalizeInboundInput(input);
  return withDatabase(databasePath, (db) => {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS sortOrder FROM inbounds').get().sortOrder;
    const result = db.prepare(`
      INSERT INTO inbounds (
        panel_id,
        name,
        inbound_id,
        subscription_name,
        subscription_base_url,
        subscription_proxy,
        total_gb_ratio,
        quota_divisor,
        xtls_vision_flow,
        enabled,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      inbound.panelId,
      inbound.name,
      inbound.inboundId,
      inbound.subscriptionName,
      inbound.subscriptionBaseUrl,
      inbound.subscriptionProxy,
      inbound.totalGbRatio,
      inbound.quotaDivisor,
      inbound.xtlsVisionFlow,
      inbound.enabled,
      Number(maxOrder) + 1
    );
    return Number(result.lastInsertRowid);
  });
}

export function updateInbound(databasePath, id, input) {
  const inboundDbId = readPositiveInteger(id, 'inbound id');
  const inbound = normalizeInboundInput(input);
  return withDatabase(databasePath, (db) => {
    const result = db.prepare(`
      UPDATE inbounds
      SET
        panel_id = ?,
        name = ?,
        inbound_id = ?,
        subscription_name = ?,
        subscription_base_url = ?,
        subscription_proxy = ?,
        total_gb_ratio = ?,
        quota_divisor = ?,
        xtls_vision_flow = ?,
        enabled = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      inbound.panelId,
      inbound.name,
      inbound.inboundId,
      inbound.subscriptionName,
      inbound.subscriptionBaseUrl,
      inbound.subscriptionProxy,
      inbound.totalGbRatio,
      inbound.quotaDivisor,
      inbound.xtlsVisionFlow,
      inbound.enabled,
      inboundDbId
    );
    if (result.changes === 0) throw new Error('inbound not found');
  });
}

export function deleteInbound(databasePath, id) {
  const inboundDbId = readPositiveInteger(id, 'inbound id');
  return withDatabase(databasePath, (db) => {
    const result = db.prepare('DELETE FROM inbounds WHERE id = ?').run(inboundDbId);
    if (result.changes === 0) throw new Error('inbound not found');
  });
}
