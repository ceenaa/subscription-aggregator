import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import {
  aggregateSubscriptions,
  formatPlainSubscription
} from './subscription.js';
import { sourcesForToken } from './source-url.js';
import { createSubscriptionFetcher } from './runtime.js';
import { renderSubscriptionPage } from './page.js';
import { formatSubscriptionUserInfo, summarizeUsage } from './usage.js';
import { buildResponseHeaders } from './response-headers.js';
import { absoluteSubscriptionUrl, getRequestUrl } from './url-context.js';

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

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(config, request, response, 405, { error: 'Only GET and HEAD are supported' }, {
          Allow: 'GET, HEAD, OPTIONS'
        });
        return;
      }

      if (url.pathname === '/health') {
        sendJson(config, request, response, 200, { ok: true });
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
      const usageSummary = summarizeUsage(result.results);
      const usageHeader = formatSubscriptionUserInfo(usageSummary);

      if (isPlainSubscription) {
        sendText(config, request, response, 200, formatPlainSubscription(result.links), {
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
            result
          }),
          {
            'Subscription-Userinfo': usageHeader
          }
        );
        return;
      }

      sendText(config, request, response, 200, `${result.encoded}\n`, {
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
  });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
