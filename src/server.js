import http from 'node:http';
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

function sendText(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(body);
}

function sendHtml(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(body);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function wantsHtml(request, url) {
  if (url.searchParams.get('format') === 'html') return true;
  if (url.searchParams.get('format') === 'base64') return false;
  return request.headers.accept?.includes('text/html') ?? false;
}

function absoluteSubscriptionUrl(url, token) {
  return `${url.origin}/sub/${encodeURIComponent(token)}`;
}

export async function createServer(config = loadConfig()) {
  const runtime = await createSubscriptionFetcher(config);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      const pathSegments = url.pathname.split('/').filter(Boolean);

      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Only GET is supported' });
        return;
      }

      if (url.pathname === '/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      const isBase64Subscription =
        pathSegments.length === 2 && pathSegments[0] === 'sub';
      const isPlainSubscription =
        pathSegments.length === 3 && pathSegments[0] === 'sub' && pathSegments[1] === 'plain';

      if (!isBase64Subscription && !isPlainSubscription) {
        sendText(
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
        sendText(response, 200, formatPlainSubscription(result.links), {
          'Subscription-Userinfo': usageHeader
        });
        return;
      }

      if (wantsHtml(request, url)) {
        const subscriptionUrl = absoluteSubscriptionUrl(url, token);
        sendHtml(
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

      sendText(response, 200, `${result.encoded}\n`, {
        'Subscription-Userinfo': usageHeader
      });
    } catch (error) {
      sendJson(response, 502, {
        error: error.message
      });
    }
  });

  return {
    server,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await runtime.close();
    }
  };
}

async function main() {
  loadDotEnv();

  const config = loadConfig();
  const app = await createServer(config);

  app.server.listen(config.port, () => {
    console.log(`subscription aggregator listening on http://127.0.0.1:${config.port}`);
    console.log(`base64 subscription: http://127.0.0.1:${config.port}/sub/:token`);
    console.log(`plain links:          http://127.0.0.1:${config.port}/sub/plain/:token`);
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
