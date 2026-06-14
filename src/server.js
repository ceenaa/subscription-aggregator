import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDotEnv } from './env.js';
import { loadConfig, refreshConfiguredTargets } from './config.js';
import {
  aggregateSubscriptions,
  encodeSubscriptionLinks,
  formatPlainSubscription,
  linksWithPanelRatioNames,
  withSubscriptionNotice
} from './subscription.js';
import { sourcesForToken } from './source-url.js';
import { createSubscriptionFetcher } from './runtime.js';
import { renderSubscriptionPage } from './page.js';
import { formatSubscriptionUserInfo, summarizeNormalizedUsage } from './usage.js';
import { buildResponseHeaders } from './response-headers.js';
import { absoluteSubscriptionUrl, getRequestUrl } from './url-context.js';
import { isAuthorized, isAdminAuthEnabled, isAdminAuthorized } from './auth.js';
import { addClientToPanels, defaultInboundFormValues } from './panel-client.js';
import { renderInboundsPage } from './inbounds-page.js';
import {
  listCreatedPanelClients,
  loadCreatedPanelClientSubscriptionUsage,
  updateCreatedPanelClient
} from './panel-clients.js';
import { renderClientsPage } from './clients-page.js';
import { CLIENTS_SCRIPT, COPY_SCRIPT, INBOUNDS_SCRIPT } from './assets.js';
import {
  createInbound,
  createPanel,
  deleteInbound,
  deletePanel,
  loadSettingsData,
  updateInbound,
  updatePanel
} from './config-store.js';
import { renderSettingsPage } from './settings-page.js';

const MODULE_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.dirname(path.dirname(MODULE_PATH));

const LOGO_ASSETS = {
  '/logos/streisand.jpg': {
    path: 'logos/streisand.jpg',
    contentType: 'image/jpeg'
  },
  '/logos/v2box.jpg': {
    path: 'logos/v2box.jpg',
    contentType: 'image/jpeg'
  },
  '/logos/v2rayng.png': {
    path: 'logos/v2rayng.png',
    contentType: 'image/png'
  }
};

function sendText(config, request, response, statusCode, body, headers = {}) {
  response.writeHead(
    statusCode,
    buildResponseHeaders(config, request, 'text/plain; charset=utf-8', headers)
  );
  response.end(body);
}

function sendHtml(config, request, response, statusCode, body, headers = {}) {
  response.writeHead(
    statusCode,
    buildResponseHeaders(config, request, 'text/html; charset=utf-8', headers)
  );
  response.end(body);
}

function sendJavaScript(config, request, response, statusCode, body, headers = {}) {
  response.writeHead(
    statusCode,
    buildResponseHeaders(config, request, 'application/javascript; charset=utf-8', headers)
  );
  response.end(body);
}

function sendBinary(config, request, response, statusCode, body, contentType, headers = {}) {
  response.writeHead(
    statusCode,
    buildResponseHeaders(config, request, contentType, headers)
  );
  response.end(body);
}

function sendJson(config, request, response, statusCode, body, headers = {}) {
  response.writeHead(
    statusCode,
    buildResponseHeaders(config, request, 'application/json; charset=utf-8', headers)
  );
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function wantsHtml(request, url) {
  if (url.searchParams.get('format') === 'html') return true;
  if (url.searchParams.get('format') === 'base64') return false;
  return request.headers.accept?.includes('text/html') ?? false;
}

function sendNoContent(config, request, response, statusCode = 204) {
  response.writeHead(statusCode, buildResponseHeaders(config, request));
  response.end();
}

function sendRedirect(config, request, response, location, statusCode = 303) {
  response.writeHead(statusCode, buildResponseHeaders(config, request, '', { Location: location }));
  response.end();
}

function sendUnauthorized(config, request, response) {
  sendText(config, request, response, 401, 'Authentication required.\n', {
    'WWW-Authenticate': 'Basic realm="Subscription Aggregator"'
  });
}

function panelsConfigured(config) {
  return config.panels.length > 0 && config.panels.every((panel) => panel.addClientUrl && panel.inboundId);
}

function readRequestBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;

    request.on('data', (chunk) => {
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        request.destroy();
        reject(new Error('Request body is too large'));
        return;
      }

      chunks.push(chunk);
    });

    request.once('end', () => {
      resolve(Buffer.concat(chunks, totalLength).toString('utf8'));
    });

    request.once('error', reject);
  });
}

function formValuesFromBody(body) {
  const params = new URLSearchParams(body);
  return {
    email: params.get('email') || '',
    clientId: params.get('clientId') || '',
    subId: params.get('subId') || '',
    totalGB: params.get('totalGB') || '',
    durationDays: params.get('durationDays') || '',
    enable: params.get('enable') === 'true' ? 'true' : 'false',
    startAfterFirstUse: params.get('startAfterFirstUse') === 'true' ? 'true' : 'false',
    comment: params.get('comment') || ''
  };
}

function buildCreatedSubscription(config, request, subId) {
  const url = absoluteSubscriptionUrl(config, request, subId);

  return {
    url,
    base64Url: `${url}?format=base64`,
    plainUrl: `${getRequestUrl(config, request).origin}/sub/plain/${encodeURIComponent(subId)}`
  };
}

function clientEditValuesFromBody(body) {
  const params = new URLSearchParams(body);
  return {
    subId: params.get('subId') || '',
    status: params.get('status') || '',
    addGB: params.get('addGB') || '',
    expiryDate: params.get('expiryDate') || '',
    expiryTime: params.get('expiryTime') || '',
    expiryAfterDays: params.get('expiryAfterDays') || '',
    clearExpiry: params.get('clearExpiry') === 'true'
  };
}

function panelValuesFromBody(body) {
  const params = new URLSearchParams(body);
  return {
    name: params.get('name') || '',
    addClientUrl: params.get('addClientUrl') || '',
    cookie: params.get('cookie') || '',
    proxy: params.get('proxy') || '',
    enabled: params.get('enabled') === 'true'
  };
}

function inboundValuesFromBody(body) {
  const params = new URLSearchParams(body);
  return {
    panelId: params.get('panelId') || '',
    name: params.get('name') || '',
    inboundId: params.get('inboundId') || '',
    subscriptionName: params.get('subscriptionName') || '',
    subscriptionBaseUrl: params.get('subscriptionBaseUrl') || '',
    subscriptionProxy: params.get('subscriptionProxy') || '',
    totalGbRatio: params.get('totalGbRatio') || '',
    quotaDivisor: params.get('quotaDivisor') || '',
    xtlsVisionFlow: params.get('xtlsVisionFlow') === 'true',
    enabled: params.get('enabled') === 'true'
  };
}

function settingsIdFromBody(body) {
  return new URLSearchParams(body).get('id') || '';
}

function renderSettings(config, request, response, statusCode, options = {}) {
  const data = loadSettingsData(config.database.path);
  sendHtml(
    config,
    request,
    response,
    statusCode,
    renderSettingsPage({
      ...data,
      databasePath: config.database.path,
      ...options
    })
  );
}

function redirectToSettings(config, request, response, message) {
  sendRedirect(config, request, response, `/settings?message=${encodeURIComponent(message)}`);
}

async function handleSettingsPost(config, request, response, pathname) {
  const body = await readRequestBody(request);

  if (pathname === '/settings/panels') {
    createPanel(config.database.path, panelValuesFromBody(body));
    refreshConfiguredTargets(config);
    redirectToSettings(config, request, response, 'Panel added.');
    return;
  }

  if (pathname === '/settings/panels/edit') {
    updatePanel(config.database.path, settingsIdFromBody(body), panelValuesFromBody(body));
    refreshConfiguredTargets(config);
    redirectToSettings(config, request, response, 'Panel updated.');
    return;
  }

  if (pathname === '/settings/panels/delete') {
    deletePanel(config.database.path, settingsIdFromBody(body));
    refreshConfiguredTargets(config);
    redirectToSettings(config, request, response, 'Panel deleted.');
    return;
  }

  if (pathname === '/settings/inbounds') {
    createInbound(config.database.path, inboundValuesFromBody(body));
    refreshConfiguredTargets(config);
    redirectToSettings(config, request, response, 'Inbound added.');
    return;
  }

  if (pathname === '/settings/inbounds/edit') {
    updateInbound(config.database.path, settingsIdFromBody(body), inboundValuesFromBody(body));
    refreshConfiguredTargets(config);
    redirectToSettings(config, request, response, 'Inbound updated.');
    return;
  }

  if (pathname === '/settings/inbounds/delete') {
    deleteInbound(config.database.path, settingsIdFromBody(body));
    refreshConfiguredTargets(config);
    redirectToSettings(config, request, response, 'Inbound deleted.');
    return;
  }

  sendJson(config, request, response, 404, { error: 'Unknown settings action' });
}

async function loadClientsView(config, runtime, request, options = {}) {
  const includeSubscriptionUsage = options.includeSubscriptionUsage === true;
  const showPanelUsage = includeSubscriptionUsage ? false : options.showPanelUsage !== false;
  const autoLoadSubscriptionUsage = options.autoLoadSubscriptionUsage === true;
  const result = await listCreatedPanelClients(runtime, config.panels, {
    sources: config.sources,
    concurrency: config.worker.concurrency,
    includeSubscriptionUsage
  });
  const clients = result.clients.map((client) => ({
    ...client,
    subscriptionUrl: absoluteSubscriptionUrl(config, request, client.subId),
    canLoadSubscriptionUsage: config.sources.length > 0 && !includeSubscriptionUsage,
    autoLoadSubscriptionUsage: config.sources.length > 0 && !includeSubscriptionUsage && autoLoadSubscriptionUsage,
    showPanelUsage
  }));

  return {
    panels: result.panels,
    clients
  };
}

async function createNodeServer(config, handler) {
  if (!config.https.enabled) return http.createServer(handler);

  const tlsOptions = {
    key: await readFile(config.https.keyPath),
    cert: await readFile(config.https.certPath)
  };

  if (config.https.caPath) {
    tlsOptions.ca = await readFile(config.https.caPath);
  }

  return https.createServer(tlsOptions, handler);
}

export async function createServer(config = loadConfig()) {
  let runtime;

  const server = await createNodeServer(config, async (request, response) => {
    try {
      if (!runtime) {
        sendJson(config, request, response, 503, { error: 'Server is not ready' });
        return;
      }

      const url = getRequestUrl(config, request);
      const pathSegments = url.pathname.split('/').filter(Boolean);

      if (request.method === 'OPTIONS') {
        sendNoContent(config, request, response);
        return;
      }

      if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
        sendJson(config, request, response, 405, { error: 'Unsupported method' }, {
          Allow: 'GET, HEAD, POST, OPTIONS'
        });
        return;
      }

      if (url.pathname === '/health') {
        sendJson(config, request, response, 200, { ok: true });
        return;
      }

      if (url.pathname === '/assets/inbounds.js') {
        sendJavaScript(config, request, response, 200, INBOUNDS_SCRIPT);
        return;
      }

      if (url.pathname === '/assets/copy.js') {
        sendJavaScript(config, request, response, 200, COPY_SCRIPT);
        return;
      }

      if (url.pathname === '/assets/clients.js') {
        sendJavaScript(config, request, response, 200, CLIENTS_SCRIPT);
        return;
      }

      const logoAsset = LOGO_ASSETS[url.pathname];
      if (logoAsset) {
        const body = await readFile(path.join(PROJECT_ROOT, logoAsset.path));
        sendBinary(config, request, response, 200, body, logoAsset.contentType);
        return;
      }

      if (url.pathname === '/settings' || url.pathname.startsWith('/settings/')) {
        if (!isAdminAuthEnabled(config)) {
          sendText(
            config,
            request,
            response,
            403,
            'ADMIN_USERNAME and ADMIN_PASSWORD must be set before using /settings.\n'
          );
          return;
        }

        if (!isAdminAuthorized(config, request)) {
          sendUnauthorized(config, request, response);
          return;
        }

        if (url.pathname === '/settings') {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendJson(config, request, response, 405, { error: 'Only GET and HEAD are supported' }, {
              Allow: 'GET, HEAD, OPTIONS'
            });
            return;
          }

          renderSettings(config, request, response, 200, {
            message: url.searchParams.get('message') || ''
          });
          return;
        }

        if (request.method !== 'POST') {
          sendJson(config, request, response, 405, { error: 'Only POST is supported' }, {
            Allow: 'POST, OPTIONS'
          });
          return;
        }

        try {
          await handleSettingsPost(config, request, response, url.pathname);
        } catch (error) {
          renderSettings(config, request, response, 400, { error: error.message });
        }
        return;
      }

      if (url.pathname === '/inbounds') {
        if (!isAuthorized(config, request)) {
          sendUnauthorized(config, request, response);
          return;
        }

        if (!panelsConfigured(config)) {
          sendHtml(
            config,
            request,
            response,
            500,
            renderInboundsPage({
              values: defaultInboundFormValues(),
              error:
                'No enabled panel inbounds are fully configured. Add panels and inbounds in /settings.'
            })
          );
          return;
        }

        if (request.method === 'GET' || request.method === 'HEAD') {
          sendHtml(
            config,
            request,
            response,
            200,
            renderInboundsPage({
              values: defaultInboundFormValues(),
              error: isAdminAuthEnabled(config) ? '' : 'ADMIN_USERNAME and ADMIN_PASSWORD are not set. Protect this page before exposing it publicly.'
            })
          );
          return;
        }

        if (request.method !== 'POST') {
          sendJson(config, request, response, 405, { error: 'Only GET and POST are supported' }, {
            Allow: 'GET, POST, OPTIONS'
          });
          return;
        }

        const values = formValuesFromBody(await readRequestBody(request));
        const results = await addClientToPanels(runtime, config.panels, values);
        sendHtml(
          config,
          request,
          response,
          200,
          renderInboundsPage({
            values,
            results,
            subscription: buildCreatedSubscription(config, request, values.subId)
          })
        );
        return;
      }

      if (url.pathname === '/clients/usage') {
        if (!isAuthorized(config, request)) {
          sendUnauthorized(config, request, response);
          return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          sendJson(config, request, response, 405, { error: 'Only GET and HEAD are supported' }, {
            Allow: 'GET, HEAD, OPTIONS'
          });
          return;
        }

        const subId = url.searchParams.get('subId') || '';
        if (!subId) {
          sendJson(config, request, response, 400, { error: 'subId is required' });
          return;
        }

        try {
          const result = await loadCreatedPanelClientSubscriptionUsage(
            runtime,
            config.sources,
            subId
          );
          sendJson(config, request, response, 200, {
            subId,
            usage: result.usage,
            sources: result.sources
          });
        } catch (error) {
          sendJson(config, request, response, 502, { error: error.message });
        }
        return;
      }

      if (url.pathname === '/clients' || url.pathname === '/clients/edit') {
        if (!isAuthorized(config, request)) {
          sendUnauthorized(config, request, response);
          return;
        }

        const isClientEdit = url.pathname === '/clients/edit';
        if (
          (isClientEdit && request.method !== 'POST') ||
          (!isClientEdit && request.method !== 'GET' && request.method !== 'HEAD')
        ) {
          sendJson(config, request, response, 405, { error: isClientEdit ? 'Only POST is supported' : 'Only GET and HEAD are supported' }, {
            Allow: isClientEdit ? 'POST, OPTIONS' : 'GET, HEAD, OPTIONS'
          });
          return;
        }

        if (!panelsConfigured(config)) {
          sendHtml(
            config,
            request,
            response,
            500,
            renderClientsPage({
              error:
                'No enabled panel inbounds are fully configured. Add panels and inbounds in /settings.'
            })
          );
          return;
        }

        let updateResult = null;
        if (isClientEdit) {
          try {
            const values = clientEditValuesFromBody(await readRequestBody(request));
            updateResult = await updateCreatedPanelClient(runtime, config.panels, values);
          } catch (error) {
            let view = { panels: config.panels, clients: [] };
            try {
              view = await loadClientsView(config, runtime, request);
            } catch {
              // Keep the original edit error visible even if reloading the table also fails.
            }

            sendHtml(
              config,
              request,
              response,
              400,
              renderClientsPage({
                ...view,
                error: error.message,
                updatedAt: new Date()
              })
            );
            return;
          }
        }

        let result;
        try {
          const usageMode = url.searchParams.get('usage');
          result = await loadClientsView(config, runtime, request, {
            includeSubscriptionUsage: usageMode === 'subscription',
            showPanelUsage: usageMode !== 'subscription'
          });
        } catch (error) {
          sendHtml(
            config,
            request,
            response,
            502,
            renderClientsPage({
              panels: config.panels,
              error: error.message
            })
          );
          return;
        }

        sendHtml(
          config,
          request,
          response,
          200,
          renderClientsPage({
            panels: result.panels,
            clients: result.clients,
            updatedAt: new Date(),
            message: updateResult ? `Updated ${updateResult.subId}` : '',
            updateResults: updateResult?.results || []
          })
        );
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(config, request, response, 405, { error: 'Only GET and HEAD are supported' }, {
          Allow: 'GET, HEAD, OPTIONS'
        });
        return;
      }

      const isBase64Subscription =
        pathSegments.length === 2 && pathSegments[0] === 'sub';
      const isPlainSubscription =
        pathSegments.length === 3 && pathSegments[0] === 'sub' && pathSegments[1] === 'plain';

      if (!isBase64Subscription && !isPlainSubscription) {
        sendText(
          config,
          request,
          response,
          404,
          'Use /sub/:token for base64 subscription output or /sub/plain/:token for decoded links.\n'
        );
        return;
      }

      const token = decodeURIComponent(isPlainSubscription ? pathSegments[2] : pathSegments[1]);
      const sources = sourcesForToken(config.sources, token);
      const result = await aggregateSubscriptions(sources, runtime.fetch);
      const updatedAt = new Date();
      const namedLinks = linksWithPanelRatioNames(result.results, config.panels);
      const usageSummary = summarizeNormalizedUsage(result.results);
      const linksWithNotice = withSubscriptionNotice(namedLinks, updatedAt, usageSummary);
      const resultWithNotice = {
        ...result,
        links: linksWithNotice,
        encoded: encodeSubscriptionLinks(linksWithNotice)
      };
      const usageHeader = formatSubscriptionUserInfo(usageSummary);

      if (isPlainSubscription) {
        sendText(config, request, response, 200, formatPlainSubscription(resultWithNotice.links), {
          'Subscription-Userinfo': usageHeader
        });
        return;
      }

      if (wantsHtml(request, url)) {
        const subscriptionUrl = absoluteSubscriptionUrl(config, request, token);
        sendHtml(
          config,
          request,
          response,
          200,
          renderSubscriptionPage({
            token,
            subscriptionUrl,
            base64Url: `${subscriptionUrl}?format=base64`,
            plainUrl: `${url.origin}/sub/plain/${encodeURIComponent(token)}`,
            result: resultWithNotice,
            usageSummary,
            updatedAt
          }),
          {
            'Subscription-Userinfo': usageHeader
          }
        );
        return;
      }

      sendText(config, request, response, 200, `${resultWithNotice.encoded}\n`, {
        'Subscription-Userinfo': usageHeader
      });
    } catch (error) {
      sendJson(config, request, response, 502, {
        error: error.message
      });
    }
  });

  runtime = await createSubscriptionFetcher(config);

  return {
    server,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await runtime?.close();
    }
  };
}

async function main() {
  loadDotEnv();

  const config = loadConfig();
  const app = await createServer(config);

  app.server.listen(config.port, config.host, () => {
    const protocol = config.https.enabled ? 'https' : 'http';
    const displayHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
    const origin = config.publicBaseUrl || `${protocol}://${displayHost}:${config.port}`;

    console.log(`subscription aggregator listening on ${origin}`);
    console.log(`base64 subscription: ${origin}/sub/:token`);
    console.log(`plain links:          ${origin}/sub/plain/:token`);
    console.log(`created clients:      ${origin}/clients`);
    console.log(`panel settings:       ${origin}/settings`);
  });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && MODULE_PATH === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
