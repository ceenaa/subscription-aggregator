import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseDotEnv } from '../src/env.js';
import {
  aggregateSubscriptions,
  buildSubscriptionNoticeLink,
  buildSubscriptionRemainingNoticeLink,
  decodeSubscriptionText,
  encodeSubscriptionLinks,
  extractSubscriptionLinks,
  linksWithPanelRatioNames,
  withSubscriptionNotice
} from '../src/subscription.js';
import { buildXrayConfigFromVlessLink } from '../src/xray.js';
import { buildSourceUrl, sourcesForToken } from '../src/source-url.js';
import { renderQrSvg } from '../src/qr.js';
import { renderSubscriptionPage } from '../src/page.js';
import { renderInboundsPage } from '../src/inbounds-page.js';
import { renderClientsPage } from '../src/clients-page.js';
import { renderSettingsPage } from '../src/settings-page.js';
import { subscriptionAppLinks } from '../src/app-links.js';
import { listCreatedPanelClients, updateCreatedPanelClient } from '../src/panel-clients.js';
import {
  formatBytes,
  normalizeCombinedUsage,
  normalizeQuotaUsage,
  parseSubscriptionUserInfo,
  summarizeNormalizedUsage,
  summarizeUsage,
  usageFromResult
} from '../src/usage.js';
import { loadConfig, refreshConfiguredTargets } from '../src/config.js';
import { createInbound, createPanel, loadSettingsData, updateInbound } from '../src/config-store.js';
import { buildResponseHeaders } from '../src/response-headers.js';
import { getRequestOrigin } from '../src/url-context.js';
import { addClientToPanels, buildAddClientRequest, buildClientSettings } from '../src/panel-client.js';
import { isAdminAuthorized, isAuthorized } from '../src/auth.js';
import { requestResponseDirect } from '../src/http-client.js';
import { createSubscriptionFetcher } from '../src/runtime.js';
import {
  buildListInboundsRequest,
  buildOnlineClientsRequest,
  buildUpdateClientRequest,
  enforcePanelQuota,
  evaluateQuotaPair,
  indexInboundClients
} from '../src/quota-worker.js';

const require = createRequire(import.meta.url);

function baseEnv(overrides = {}) {
  return {
    PORT: '3000',
    REQUEST_TIMEOUT_MS: '15000',
    XRAY_BIN: './xray',
    FIRST_SUBSCRIPTION_BASE_URL: 'https://first-provider.example/sub',
    SECOND_SUBSCRIPTION_BASE_URL: 'https://second-provider.example/sub',
    XRAY_OUTBOUND_LINK:
      'vless://11111111-1111-4111-8111-111111111111@proxy.example:443?type=ws&encryption=none&path=%2F&host=edge.example&security=tls&sni=tls.example#test-proxy',
    ...overrides
  };
}

function applyInboundClientUpdate(inbound, body) {
  const updatedClient = JSON.parse(body);
  const settings = JSON.parse(inbound.settings);
  settings.clients = settings.clients.map((client) =>
    client.subId === updatedClient.subId || client.email === updatedClient.email
      ? { ...client, ...updatedClient }
      : client
  );
  inbound.settings = JSON.stringify(settings);

  for (const stat of inbound.clientStats || []) {
    if ((stat.subId === updatedClient.subId || stat.email === updatedClient.email) && updatedClient.enable !== undefined) {
      stat.enable = updatedClient.enable;
    }
  }
}

test('decodes a base64 v2ray subscription body', () => {
  const link = 'vless://user@example.com:443?security=tls#example';
  const encoded = Buffer.from(`${link}\n`, 'utf8').toString('base64');

  assert.equal(decodeSubscriptionText(encoded), `${link}\n`);
  assert.deepEqual(extractSubscriptionLinks(encoded), [link]);
});

test('aggregates subscriptions and removes exact duplicates', async () => {
  const firstLink = 'vless://first@example.com:443?security=tls#first';
  const secondLink = 'vmess://second';
  const thirdLink = 'ss://third';

  const sources = [
    {
      name: 'first',
      body: Buffer.from(`${firstLink}\n${secondLink}\n`, 'utf8').toString('base64')
    },
    {
      name: 'second',
      body: `${firstLink}\n${thirdLink}\n`
    }
  ];

  const result = await aggregateSubscriptions(sources, (source) => source.body);

  assert.deepEqual(result.links, [firstLink, secondLink, thirdLink]);
  assert.equal(result.encoded, encodeSubscriptionLinks(result.links));
});

test('adds a local shadowsocks notice config for subscription clients', () => {
  const notice = buildSubscriptionNoticeLink(new Date('2026-05-30T12:34:56Z'));
  const remainingNotice = buildSubscriptionRemainingNoticeLink({
    hasData: true,
    remaining: 5 * 1024 ** 3
  });
  const noticeName = decodeURIComponent(notice.split('#')[1]);
  const remainingNoticeName = decodeURIComponent(remainingNotice.split('#')[1]);
  const links = withSubscriptionNotice(['vless://user@example.com:443#real'], '2026-05-30T12:34:56Z');
  const linksWithUsage = withSubscriptionNotice(
    ['vless://user@example.com:443#real'],
    '2026-05-30T12:34:56Z',
    {
      hasData: true,
      remaining: 5 * 1024 ** 3
    }
  );
  const noticeNames = links.slice(1).map((link) => decodeURIComponent(link.split('#')[1]));
  const usageNoticeName = decodeURIComponent(linksWithUsage[3].split('#')[1]);

  assert.match(notice, /^ss:\/\//);
  assert.match(notice, /@127\.0\.0\.1:1#/);
  assert.match(remainingNotice, /^ss:\/\//);
  assert.match(remainingNotice, /@127\.0\.0\.1:3#/);
  assert.match(noticeName, /آخرین بروزرسانی: 2026\/05\/30 16:04/);
  assert.equal(remainingNoticeName, 'باقیمانده کل: 5.00 GB');
  assert.equal(links.length, 3);
  assert.equal(linksWithUsage.length, 4);
  assert.match(links[1], /^ss:\/\//);
  assert.match(links[1], /@127\.0\.0\.1:1#/);
  assert.match(links[2], /^ss:\/\//);
  assert.match(links[2], /@127\.0\.0\.1:2#/);
  assert.match(linksWithUsage[3], /@127\.0\.0\.1:3#/);
  assert.equal(usageNoticeName, 'باقیمانده کل: 5.00 GB');
  assert.deepEqual(noticeNames, [
    'آخرین بروزرسانی: 2026/05/30 16:04',
    'لینک اشتراک را روزانه بروزرسانی کنید'
  ]);
  assert.deepEqual(extractSubscriptionLinks(`${links.join('\n')}\n`), links);
});

test('adds panel ratio text to aggregated subscription link names', () => {
  const namedLinks = linksWithPanelRatioNames(
    [
      {
        source: { name: 'first' },
        links: ['vless://user1@example.com:443?security=tls#first-node-4.96GB📊-29D,21H⏳']
      },
      {
        source: { name: 'second' },
        links: ['trojan://user2@example.com:443?security=tls#second-node-1.25GB📊']
      }
    ],
    [{ totalGbRatio: 1 }, { totalGbRatio: 2.5 }]
  );

  assert.equal(
    decodeURIComponent(namedLinks[0].split('#')[1]),
    'first-node - ⚖️ مصرف با ضریب 1'
  );
  assert.equal(
    decodeURIComponent(namedLinks[1].split('#')[1]),
    'second-node - ⚖️ مصرف با ضریب 2.5'
  );
});

test('adds panel ratio text to vmess ps names', () => {
  const vmessConfig = {
    v: '2',
    ps: 'vmess-node-512MB📊-8H⏳',
    add: 'example.com',
    port: '443',
    id: '11111111-1111-4111-8111-111111111111',
    aid: '0',
    net: 'ws',
    type: 'none',
    host: 'example.com',
    path: '/',
    tls: 'tls'
  };
  const vmessLink = `vmess://${Buffer.from(JSON.stringify(vmessConfig), 'utf8').toString('base64')}`;
  const [namedLink] = linksWithPanelRatioNames(
    [{ source: { name: 'first' }, links: [vmessLink] }],
    [{ totalGbRatio: 3 }]
  );
  const namedConfig = JSON.parse(Buffer.from(namedLink.slice('vmess://'.length), 'base64').toString('utf8'));

  assert.equal(namedConfig.ps, 'vmess-node - ⚖️ مصرف با ضریب 3');
});

test('parses .env values with quotes', () => {
  assert.deepEqual(
    parseDotEnv(`
PORT=3000
XRAY_OUTBOUND_LINK='vless://id@example.com:443?type=ws#name'
FIRST_SUBSCRIPTION_BASE_URL=https://example.com/sub
`),
    {
      PORT: '3000',
      XRAY_OUTBOUND_LINK: 'vless://id@example.com:443?type=ws#name',
      FIRST_SUBSCRIPTION_BASE_URL: 'https://example.com/sub'
    }
  );
});

test('loads production HTTP, HTTPS, CORS, and proxy config', () => {
  const config = loadConfig(
    baseEnv({
      HOST: '0.0.0.0',
      HTTPS_ENABLED: 'true',
      HTTPS_KEY_PATH: '/tmp/key.pem',
      HTTPS_CERT_PATH: '/tmp/cert.pem',
      HTTPS_HSTS_MAX_AGE: '31536000',
      TRUST_PROXY: 'true',
      PUBLIC_BASE_URL: 'https://subscriptions.example',
      CORS_ORIGIN: 'https://app.example, https://admin.example',
      WORKER_CONCURRENCY: '7'
    })
  );

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.https.enabled, true);
  assert.equal(config.https.keyPath, '/tmp/key.pem');
  assert.equal(config.https.certPath, '/tmp/cert.pem');
  assert.equal(config.https.hstsEnabled, true);
  assert.equal(config.https.hstsMaxAge, 31536000);
  assert.equal(config.trustProxy, true);
  assert.equal(config.publicBaseUrl, 'https://subscriptions.example');
  assert.deepEqual(config.cors.origins, ['https://app.example', 'https://admin.example']);
  assert.equal(config.worker.concurrency, 7);
});

test('builds security and CORS response headers', () => {
  const config = loadConfig(
    baseEnv({
      HTTPS_ENABLED: 'true',
      HTTPS_KEY_PATH: '/tmp/key.pem',
      HTTPS_CERT_PATH: '/tmp/cert.pem',
      CORS_ORIGIN: 'https://app.example'
    })
  );

  const headers = buildResponseHeaders(
    config,
    {
      headers: {
        origin: 'https://app.example',
        accept: 'text/html'
      }
    },
    'text/html; charset=utf-8',
    {
      'Subscription-Userinfo': 'upload=1; download=2; total=3; expire=0'
    }
  );

  assert.equal(headers['Access-Control-Allow-Origin'], 'https://app.example');
  assert.equal(headers['Access-Control-Expose-Headers'], 'Subscription-Userinfo');
  assert.equal(headers['Strict-Transport-Security'], 'max-age=15552000; includeSubDomains');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Security-Policy'], /script-src 'self'/);
  assert.equal(headers['Subscription-Userinfo'], 'upload=1; download=2; total=3; expire=0');
  assert.match(headers.Vary, /Origin/);
  assert.match(headers.Vary, /Accept/);
});

test('direct HTTP requests enforce a hard deadline while response keeps streaming', async (context) => {
  const sockets = new Set();
  const intervals = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n');
      const interval = setInterval(() => {
        socket.write('x');
      }, 10);
      intervals.add(interval);
      socket.once('close', () => {
        clearInterval(interval);
        intervals.delete(interval);
      });
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code === 'EPERM') {
      context.skip('local listening sockets are blocked in this sandbox');
      return;
    }
    throw error;
  }

  const { port } = server.address();
  const startedAt = Date.now();

  try {
    await assert.rejects(
      () => requestResponseDirect(`http://127.0.0.1:${port}/stream`, { timeoutMs: 50 }),
      /timed out/
    );
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    for (const interval of intervals) clearInterval(interval);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('builds public request origins from proxy headers or public base URL', () => {
  assert.equal(
    getRequestOrigin(
      loadConfig(baseEnv({ TRUST_PROXY: 'true' })),
      {
        headers: {
          host: 'internal.example',
          'x-forwarded-host': 'public.example',
          'x-forwarded-proto': 'https'
        },
        socket: {}
      }
    ),
    'https://public.example'
  );

  assert.equal(
    getRequestOrigin(
      loadConfig(baseEnv({ PUBLIC_BASE_URL: 'https://subscriptions.example/' })),
      {
        headers: {
          host: 'internal.example'
        },
        socket: {}
      }
    ),
    'https://subscriptions.example'
  );
});

test('shares one Xray proxy startup across concurrent routed requests', async () => {
  let starts = 0;
  let stops = 0;
  const runtime = await createSubscriptionFetcher(
    {
      requestTimeoutMs: 15000,
      xrayBin: 'xray',
      xrayOutboundLink:
        'vless://11111111-1111-4111-8111-111111111111@proxy.example:443?type=ws&encryption=none&security=tls'
    },
    {
      async startXrayHttpProxy() {
        starts += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          port: 31337,
          async stop() {
            stops += 1;
          }
        };
      },
      async requestResponseViaHttpProxy(url, options) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ url, proxyPort: options.proxyPort })
        };
      },
      async fetchResponseViaHttpProxy(url, options) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ url, proxyPort: options.proxyPort })
        };
      }
    }
  );

  await Promise.all([
    runtime.request({ name: 'first', proxy: 'xray', url: 'https://first.example/list' }, {}),
    runtime.request({ name: 'second', proxy: 'xray', url: 'https://second.example/list' }, {}),
    runtime.fetch({ name: 'third', proxy: 'xray', url: 'https://third.example/sub' })
  ]);
  await runtime.close();

  assert.equal(starts, 1);
  assert.equal(stops, 1);
});

test('builds 3x-ui addClient JSON requests without real panel values', () => {
  const panel = {
    name: 'first-panel',
    addClientUrl: 'https://panel.example/secret/panel/api/inbounds/addClient',
    cookie: '3x-ui=fake-cookie; lang=en-US',
    inboundId: '4',
    proxy: 'xray'
  };
  const input = {
    clientId: '11111111-1111-4111-8111-111111111111',
    email: 'client@example.com',
    subId: 'clienttoken123',
    totalGB: '0',
    durationDays: '0',
    enable: 'true',
    startAfterFirstUse: 'false',
    comment: ''
  };

  const request = buildAddClientRequest(panel, input);
  const body = JSON.parse(request.body);

  assert.equal(request.url, 'https://panel.example/secret/panel/api/clients/add');
  assert.deepEqual(body.inboundIds, [4]);
  assert.equal(body.client.id, input.clientId);
  assert.equal(body.client.email, input.email);
  assert.equal(body.client.subId, input.subId);
  assert.equal(body.client.totalGB, 0);
  assert.equal(body.client.expiryTime, 0);
  assert.equal(body.client.enable, true);
  assert.equal(body.client.flow, '');
  assert.equal(body.client.limitIp, 0);
  assert.equal(body.client.tgId, 0);
  assert.equal(body.client.comment, '');
  assert.equal(request.headers.Cookie, panel.cookie);
  assert.equal(request.headers.Origin, 'https://panel.example');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.method, 'POST');
});

test('applies panel total flow ratios as divisors to addClient requests', () => {
  const input = {
    clientId: '11111111-1111-4111-8111-111111111111',
    email: 'client@example.com',
    subId: 'clienttoken123',
    totalGB: '5',
    durationDays: '0',
    enable: 'true',
    startAfterFirstUse: 'false',
    comment: ''
  };
  const first = buildAddClientRequest(
    {
      name: 'first-panel',
      addClientUrl: 'https://first-panel.example/secret/panel/api/inbounds/addClient',
      inboundId: '4',
      proxy: 'xray',
      totalGbRatio: 1
    },
    input
  );
  const second = buildAddClientRequest(
    {
      name: 'second-panel',
      addClientUrl: 'https://second-panel.example/secret/panel/api/inbounds/addClient',
      inboundId: '4',
      proxy: 'direct',
      totalGbRatio: 2
    },
    input
  );

  assert.equal(first.settings.clients[0].totalGB, 5 * 1024 ** 3);
  assert.equal(second.settings.clients[0].totalGB, 2.5 * 1024 ** 3);
});

test('applies a panel XTLS vision flow to addClient requests', () => {
  const request = buildAddClientRequest(
    {
      name: 'vision-inbound',
      addClientUrl: 'https://vision-panel.example/secret/panel/api/inbounds/addClient',
      inboundId: '4',
      proxy: 'direct',
      clientFlow: 'xtls-rprx-vision'
    },
    {
      clientId: '11111111-1111-4111-8111-111111111111',
      email: 'client@example.com',
      subId: 'clienttoken123',
      totalGB: '0',
      durationDays: '0',
      enable: 'true',
      startAfterFirstUse: 'false',
      comment: ''
    }
  );

  assert.equal(request.settings.clients[0].flow, 'xtls-rprx-vision');
});

test('batches same-server inbounds into one addClient request', async () => {
  const input = {
    clientId: '11111111-1111-4111-8111-111111111111',
    email: 'client@example.com',
    subId: 'clienttoken123',
    totalGB: '5',
    durationDays: '0',
    enable: 'true',
    startAfterFirstUse: 'false',
    comment: ''
  };
  const panels = [
    {
      name: 'first-panel',
      addClientUrl: 'https://same-panel.example/secret/panel/api/inbounds/addClient',
      inboundId: '4',
      proxy: 'direct',
      totalGbRatio: 1
    },
    {
      name: 'second-panel',
      addClientUrl: 'https://same-panel.example/secret/panel/api/inbounds/addClient',
      inboundId: '6',
      proxy: 'direct',
      totalGbRatio: 1
    },
    {
      name: 'third-panel',
      addClientUrl: 'https://other-panel.example/secret/panel/api/inbounds/addClient',
      inboundId: '8',
      proxy: 'direct',
      totalGbRatio: 1
    }
  ];
  const requests = [];
  const runtime = {
    async request(target, options) {
      requests.push({ name: target.name, body: JSON.parse(options.body) });
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, obj: null })
      };
    }
  };

  const results = await addClientToPanels(runtime, panels, input);

  // Two servers → two API requests (not three)
  assert.equal(requests.length, 2);

  // same-panel.example: one request with both inbound IDs
  assert.deepEqual(requests[0].body.inboundIds, [4, 6]);
  assert.equal(requests[0].body.client.email, 'client@example.com');

  // other-panel.example: separate request with its own inbound ID
  assert.deepEqual(requests[1].body.inboundIds, [8]);
  assert.equal(requests[1].body.client.email, 'client@example.com');

  // All three panel entries report success
  assert.equal(results.every((r) => r.ok), true);
  assert.equal(results[0].panel.name, 'first-panel');
  assert.equal(results[1].panel.name, 'second-panel');
  assert.equal(results[2].panel.name, 'third-panel');
});

test('creates clients through Xray panels before direct panels and skips direct after Xray failure', async () => {
  const input = {
    clientId: '11111111-1111-4111-8111-111111111111',
    email: 'client@example.com',
    subId: 'clienttoken123',
    totalGB: '5',
    durationDays: '0',
    enable: 'true',
    startAfterFirstUse: 'false',
    comment: ''
  };
  const panels = [
    {
      name: 'xray-panel',
      addClientUrl: 'https://xray-panel.example/secret/panel/api/inbounds/addClient',
      inboundId: '4',
      proxy: 'xray',
      totalGbRatio: 1
    },
    {
      name: 'direct-panel',
      addClientUrl: 'https://direct-panel.example/secret/panel/api/inbounds/addClient',
      inboundId: '6',
      proxy: 'direct',
      totalGbRatio: 1
    }
  ];
  const requests = [];
  const runtime = {
    async request(target) {
      requests.push(target.name);
      if (target.name === 'xray-panel') {
        throw new Error('xray unavailable');
      }

      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, obj: null })
      };
    }
  };

  const results = await addClientToPanels(runtime, panels, input);

  assert.deepEqual(requests, ['xray-panel', 'xray-panel', 'xray-panel', 'xray-panel']);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /xray unavailable after 4 attempts/);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].skipped, true);
  assert.match(results[1].error, /skipped after Xray failure/);
});

test('builds 3x-ui list and update requests for the quota worker', () => {
  const panel = {
    name: 'first-panel',
    addClientUrl: 'https://panel.example/secret/panel/api/inbounds/addClient',
    cookie: '3x-ui=fake-cookie; lang=en-US',
    inboundId: '4',
    proxy: 'xray'
  };
  const inbound = { id: 4 };
  const client = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'client@example.com',
    subId: 'clienttoken123',
    enable: true,
    totalGB: 5 * 1024 ** 3
  };

  const listRequest = buildListInboundsRequest(panel);
  const onlineRequest = buildOnlineClientsRequest(panel);
  const updateRequest = buildUpdateClientRequest(panel, inbound, client);
  const updateBody = JSON.parse(updateRequest.body);

  assert.equal(listRequest.url, 'https://panel.example/secret/panel/api/inbounds/list');
  assert.equal(listRequest.headers.Cookie, panel.cookie);
  assert.equal(onlineRequest.url, 'https://panel.example/secret/panel/api/clients/onlines');
  assert.equal(onlineRequest.method, 'POST');
  assert.equal(onlineRequest.body, '');
  assert.equal(onlineRequest.headers.Cookie, panel.cookie);
  assert.equal(onlineRequest.headers.Origin, 'https://panel.example');
  assert.equal(onlineRequest.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(updateRequest.url, 'https://panel.example/secret/panel/api/clients/update/client%40example.com');
  assert.equal(updateRequest.headers['Content-Type'], 'application/json');
  assert.equal(updateBody.enable, false);
  assert.equal(updateBody.totalGB, 5 * 1024 ** 3);
  assert.equal(updateRequest.headers.Origin, 'https://panel.example');
});

test('indexes inbound clients and evaluates ratio quota conditions', () => {
  const panel = { name: 'first-panel', quotaDivisor: 2 };
  const inbound = {
    id: 4,
    settings: JSON.stringify({
      clients: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'client@example.com',
          subId: 'clienttoken123',
          enable: true,
          totalGB: 5 * 1024 ** 3
        }
      ]
    }),
    clientStats: [
      {
        subId: 'clienttoken123',
        allTime: 6 * 1024 ** 3,
        total: 5 * 1024 ** 3
      }
    ]
  };
  const clients = indexInboundClients(panel, inbound);
  const first = clients.get('clienttoken123');
  const second = {
    ...first,
    panel: { name: 'second-panel' },
    total: 10 * 1024 ** 3,
    allTime: 1 * 1024 ** 3
  };
  const unlimitedFirst = {
    ...first,
    total: 0,
    allTime: 100 * 1024 ** 3
  };

  assert.equal(clients.size, 1);
  assert.equal(first.email, 'client@example.com');
  assert.equal(first.quotaDivisor, 2);
  assert.equal(evaluateQuotaPair(first, second).exceeded, true);
  assert.equal(evaluateQuotaPair(unlimitedFirst, second).exceeded, false);
});

test('normalizes combined used traffic to the higher quota', () => {
  const gib = 1024 ** 3;
  const first = {
    panel: { name: 'first-panel' },
    total: 5 * gib,
    allTime: 2 * gib
  };
  const second = {
    panel: { name: 'second-panel' },
    total: 10 * gib,
    allTime: 6 * gib
  };
  const evaluation = evaluateQuotaPair(first, second);
  const combined = normalizeCombinedUsage([first, second]);

  assert.equal(evaluation.exceeded, true);
  assert.equal(evaluation.combinedTotal, 10 * gib);
  assert.equal(evaluation.combinedAllTime, 10 * gib);
  assert.equal(evaluation.combinedScale, 2);
  assert.deepEqual(evaluation.reasons, ['combined normalized quota exceeded']);
  assert.equal(combined.total, 10 * gib);
  assert.equal(combined.used, 10 * gib);
  assert.equal(combined.remaining, 0);
  assert.equal(combined.scale, 2);
});

test('normalizes panel usage with total GB ratios before combining', () => {
  const gib = 1024 ** 3;
  const first = {
    panel: { name: 'ratio-panel', totalGbRatio: 2 },
    total: 5 * gib,
    allTime: 1 * gib
  };
  const second = {
    panel: { name: 'base-panel', totalGbRatio: 1 },
    total: 8 * gib,
    allTime: 1 * gib
  };
  const combined = normalizeCombinedUsage([first, second]);

  assert.equal(combined.total, 10 * gib);
  assert.equal(combined.used, 3.25 * gib);
  assert.equal(combined.remaining, 6.75 * gib);
});

test('quota evaluation prefers current upload and download over allTime', () => {
  const gib = 1024 ** 3;
  const first = {
    panel: { name: 'first-panel' },
    total: 5 * gib,
    upload: 128 * 1024 ** 2,
    download: 128 * 1024 ** 2,
    hasCurrentUsage: true,
    allTime: 50 * gib
  };
  const second = {
    panel: { name: 'second-panel' },
    total: 5 * gib,
    upload: 64 * 1024 ** 2,
    download: 64 * 1024 ** 2,
    hasCurrentUsage: true,
    allTime: 50 * gib
  };
  const evaluation = evaluateQuotaPair(first, second);

  assert.equal(evaluation.exceeded, false);
  assert.equal(evaluation.combinedTotal, 5 * gib);
  assert.equal(evaluation.combinedAllTime, 384 * 1024 ** 2);
  assert.deepEqual(evaluation.reasons, []);
});

test('uses one quota divisor rule for subscription summaries and worker entries', () => {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  const cdnUsage = {
    total: 20 * gib,
    upload: 206.77 * mib,
    download: 8.78 * gib,
    quotaDivisor: 2
  };
  const secondUsage = {
    total: 5 * gib,
    used: 578.32 * mib
  };
  const normalizedCdnUsage = normalizeQuotaUsage(cdnUsage);
  const combined = normalizeCombinedUsage([cdnUsage, secondUsage]);
  const evaluation = evaluateQuotaPair(
    {
      panel: { name: 'cdn1' },
      total: 20 * gib,
      allTime: normalizedCdnUsage.used,
      quotaDivisor: 2
    },
    {
      panel: { name: 'second-panel' },
      total: 5 * gib,
      allTime: secondUsage.used
    }
  );

  assert.equal(normalizedCdnUsage.total, 10 * gib);
  assert.equal(formatBytes(normalizedCdnUsage.used), '8.98 GB');
  assert.equal(formatBytes(combined.total), '10.00 GB');
  assert.equal(formatBytes(combined.used), '10.11 GB');
  assert.equal(combined.remaining, 0);
  assert.deepEqual(evaluation.reasons, ['combined normalized quota exceeded']);
});

test('lists only clients present in every configured panel inbound', async () => {
  const gib = 1024 ** 3;
  const firstPanel = {
    name: 'cdn1',
    addClientUrl: 'https://cdn1.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'xray',
    quotaDivisor: 2
  };
  const secondPanel = {
    name: 'second-panel',
    addClientUrl: 'https://second.example/secret/panel/api/inbounds/addClient',
    inboundId: '8',
    proxy: 'direct',
    quotaDivisor: 1
  };
  const sharedFirstClient = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'shared',
    subId: 'shared-sub',
    enable: true,
    totalGB: 20 * gib
  };
  const firstOnlyClient = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'first-only',
    subId: 'first-only-sub',
    enable: true,
    totalGB: 20 * gib
  };
  const sharedSecondClient = {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'shared',
    subId: 'shared-sub',
    enable: true,
    totalGB: 5 * gib
  };
  const firstInbound = {
    id: 4,
    settings: JSON.stringify({ clients: [sharedFirstClient, firstOnlyClient] }),
    clientStats: [
      {
        subId: 'shared-sub',
        enable: false,
        allTime: 99 * gib,
        up: 1 * gib,
        down: 7 * gib,
        total: 20 * gib
      },
      {
        subId: 'first-only-sub',
        enable: true,
        allTime: 3 * gib,
        total: 20 * gib
      }
    ]
  };
  const secondInbound = {
    id: 8,
    settings: JSON.stringify({ clients: [sharedSecondClient] }),
    clientStats: [
      {
        subId: 'shared-sub',
        enable: false,
        allTime: 2 * gib,
        up: 0.25 * gib,
        down: 0.25 * gib,
        total: 5 * gib
      }
    ]
  };
  let fetchCalls = 0;
  const runtime = {
    async request(target) {
      if (target.url.endsWith('/onlines')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            obj: target.name === 'cdn1' ? ['shared', 'first-only'] : ['shared']
          })
        };
      }

      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          success: true,
          obj: target.name === 'cdn1' ? [firstInbound] : [secondInbound]
        })
      };
    },
    async fetch(source) {
      fetchCalls += 1;
      const firstLink = 'vless://11111111-1111-4111-8111-111111111111@example.com:443#one';
      const secondLink = 'vless://22222222-2222-4222-8222-222222222222@example.com:443#two';
      const isFirst = source.name === 'wcloud';

      return {
        statusCode: 200,
        headers: {
          'subscription-userinfo': isFirst
            ? `upload=${1 * gib}; download=${1 * gib}; total=${20 * gib}; expire=0`
            : `upload=${0.25 * gib}; download=${0.25 * gib}; total=${5 * gib}; expire=0`
        },
        body: isFirst ? `${firstLink}\n${secondLink}\n` : `${firstLink}\n`
      };
    }
  };

  const result = await listCreatedPanelClients(runtime, [firstPanel, secondPanel], {
    sources: [
      { name: 'wcloud', baseUrl: 'https://wcloud.example/sub', proxy: 'xray' },
      { name: 'nimcloud', baseUrl: 'https://nimcloud.example/sub', proxy: 'direct' }
    ],
    concurrency: 2
  });
  const clientsWithUrls = result.clients.map((client) => ({
    ...client,
    subscriptionUrl: `https://subscriptions.example/sub/${client.subId}`
  }));
  const html = renderClientsPage({
    panels: result.panels,
    clients: clientsWithUrls,
    updatedAt: new Date('2026-06-02T10:00:00Z')
  });

  assert.equal(result.clients.length, 1);
  assert.equal(fetchCalls, 2);
  assert.equal(result.clients[0].subId, 'shared-sub');
  assert.equal(result.clients[0].status, 'Active');
  assert.equal(result.clients[0].enabledPanels, 2);
  assert.equal(result.clients[0].usage.total, 20 * gib);
  assert.equal(result.clients[0].usage.used, 4 * gib);
  assert.equal(result.clients[0].usage.remaining, 16 * gib);
  assert.equal(result.clients[0].sources.length, 2);
  assert.equal(result.clients[0].sources[0].source, 'wcloud');
  assert.equal(result.clients[0].sources[0].links, 2);
  assert.equal(result.clients[0].sources[0].total, 20 * gib);
  assert.equal(result.clients[0].sources[0].used, 2 * gib);
  assert.equal(result.clients[0].panels[0].total, 10 * gib);
  assert.equal(result.clients[0].panels[0].used, 8 * gib);
  assert.equal(result.panels[0].onlineCount, 2);
  assert.equal(result.panels[0].activeClients, 2);
  assert.equal(result.panels[0].inactiveClients, 0);
  assert.equal(result.panels[0].totalClients, 2);
  assert.equal(result.panels[1].onlineCount, 1);
  assert.equal(result.panels[1].activeClients, 1);
  assert.equal(result.panels[1].inactiveClients, 0);
  assert.equal(result.panels[1].totalClients, 1);
  assert.match(html, /Created Configurations/);
  assert.match(html, /Subscription Usage/);
  assert.match(html, /Panel Status/);
  assert.match(html, /wcloud/);
  assert.match(html, /data-client-search-form/);
  assert.match(html, /Email or subscription ID/);
  assert.doesNotMatch(html, />Search<\/button>/);
  assert.match(html, /data-edit-toggle/);
  assert.match(html, /action="\/clients\/edit"/);
  assert.match(html, /name="expiryAfterDays" value="30"/);
  assert.match(html, /Set expiry to 30 days from now/);
  assert.match(html, /Add Usage \(GB\)/);
  assert.match(html, /data-expiry-time/);
  assert.match(html, /No expiry/);
  assert.match(html, /data-client-search="shared shared-sub"/);
  assert.match(html, /\/assets\/clients\.js/);
  assert.match(html, /shared-sub/);
  assert.match(html, /4\.00 GB/);
  assert.match(html, /panel-summary-card/);
  assert.match(html, /online-pill/);
  assert.match(html, />Online<\/span>\s*<b>2<\/b>/);
  assert.match(html, />Active<\/span>\s*<strong>2\/2<\/strong>/);
  assert.match(html, />Inactive<\/span>\s*<strong>0\/2<\/strong>/);
  assert.match(html, /summary-meter/);
  assert.doesNotMatch(html, /first-only-sub/);

  fetchCalls = 0;
  const fastResult = await listCreatedPanelClients(runtime, [firstPanel, secondPanel], {
    sources: [
      { name: 'wcloud', baseUrl: 'https://wcloud.example/sub', proxy: 'xray' },
      { name: 'nimcloud', baseUrl: 'https://nimcloud.example/sub', proxy: 'direct' }
    ],
    concurrency: 2,
    includeSubscriptionUsage: false
  });
  const fastHtml = renderClientsPage({
    panels: fastResult.panels,
    clients: fastResult.clients.map((client) => ({
      ...client,
      subscriptionUrl: `https://subscriptions.example/sub/${client.subId}`,
      canLoadSubscriptionUsage: true
    })),
    updatedAt: new Date('2026-06-02T10:00:00Z')
  });

  assert.equal(fetchCalls, 0);
  assert.equal(fastResult.clients[0].sources.length, 0);
  assert.equal(fastResult.clients[0].usage.total, 10 * gib);
  assert.equal(fastResult.clients[0].usage.used, 9 * gib);
  assert.match(fastHtml, /data-source-usage/);
  assert.match(fastHtml, /data-sub-id="shared-sub"/);
  assert.match(fastHtml, /Loading subscription usage/);
  assert.match(fastHtml, /9\.00 GB/);
});

test('summarizes multiple inbounds from the same panel once', async () => {
  const firstInboundPanel = {
    name: '1x',
    panelName: 'cdn-panel',
    panelDbId: 10,
    addClientUrl: 'https://cdn.example/secret/panel/api/inbounds/addClient',
    inboundId: '6',
    proxy: 'xray',
    quotaDivisor: 1
  };
  const secondInboundPanel = {
    name: '2x',
    panelName: 'cdn-panel',
    panelDbId: 10,
    addClientUrl: 'https://cdn.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'xray',
    quotaDivisor: 1
  };
  const firstInbound = {
    id: 6,
    settings: JSON.stringify({
      clients: [
        { email: 'shared', subId: 'shared-sub', enable: false },
        { email: 'first-only', subId: 'first-only-sub', enable: false }
      ]
    }),
    clientStats: []
  };
  const secondInbound = {
    id: 4,
    settings: JSON.stringify({
      clients: [
        { email: 'shared', subId: 'shared-sub', enable: true },
        { email: 'second-only', subId: 'second-only-sub', enable: true }
      ]
    }),
    clientStats: []
  };
  let onlineCalls = 0;
  const runtime = {
    async request(target) {
      if (target.url.endsWith('/onlines')) {
        onlineCalls += 1;
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ success: true, obj: ['shared', 'second-only', 'someone'] })
        };
      }

      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, obj: [firstInbound, secondInbound] })
      };
    }
  };

  const result = await listCreatedPanelClients(runtime, [firstInboundPanel, secondInboundPanel], {
    includeSubscriptionUsage: false
  });
  const html = renderClientsPage({
    panels: result.panels,
    clients: [],
    updatedAt: new Date('2026-06-15T10:00:00Z')
  });

  assert.equal(onlineCalls, 1);
  assert.equal(result.panels.length, 1);
  assert.equal(result.panels[0].name, 'cdn-panel');
  assert.equal(result.panels[0].inboundCount, 2);
  assert.deepEqual(result.panels[0].inboundIds, ['6', '4']);
  assert.equal(result.panels[0].onlineCount, 3);
  assert.equal(result.panels[0].totalClients, 3);
  assert.equal(result.panels[0].activeClients, 2);
  assert.equal(result.panels[0].inactiveClients, 1);
  assert.equal((html.match(/<li class="panel-summary-card">/g) || []).length, 1);
  assert.match(html, /cdn-panel/);
  assert.match(html, /2 inbounds/);
  assert.match(html, />Online<\/span>\s*<b>3<\/b>/);
  assert.match(html, />Active<\/span>\s*<strong>2\/3<\/strong>/);
  assert.match(html, />Inactive<\/span>\s*<strong>1\/3<\/strong>/);
  assert.doesNotMatch(html, /<strong>1x<\/strong>/);
  assert.doesNotMatch(html, /<strong>2x<\/strong>/);
});

test('counts shared same-panel client usage once on the clients page', async () => {
  const gib = 1024 ** 3;
  const firstInboundPanel = {
    name: '1x',
    panelName: 'cdn-panel',
    panelDbId: 10,
    addClientUrl: 'https://cdn.example/secret/panel/api/inbounds/addClient',
    inboundId: '6',
    proxy: 'xray',
    quotaDivisor: 1
  };
  const secondInboundPanel = {
    name: '2x',
    panelName: 'cdn-panel',
    panelDbId: 10,
    addClientUrl: 'https://cdn.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'xray',
    quotaDivisor: 1
  };
  const sharedClient = {
    email: 'shared',
    subId: 'shared-sub',
    enable: true,
    totalGB: 10 * gib
  };
  const firstInbound = {
    id: 6,
    settings: JSON.stringify({ clients: [sharedClient] }),
    clientStats: [
      { email: 'shared', subId: 'shared-sub', enable: true, total: 10 * gib, allTime: 6 * gib }
    ]
  };
  const secondInbound = {
    id: 4,
    settings: JSON.stringify({ clients: [sharedClient] }),
    clientStats: [
      { email: 'shared', subId: 'shared-sub', enable: true, total: 10 * gib, allTime: 6 * gib }
    ]
  };
  const runtime = {
    async request(target) {
      if (target.url.endsWith('/onlines')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ success: true, obj: ['shared'] })
        };
      }

      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, obj: [firstInbound, secondInbound] })
      };
    }
  };

  const result = await listCreatedPanelClients(runtime, [firstInboundPanel, secondInboundPanel], {
    includeSubscriptionUsage: false
  });
  const html = renderClientsPage({
    panels: result.panels,
    clients: result.clients.map((client) => ({
      ...client,
      subscriptionUrl: `https://subscriptions.example/sub/${client.subId}`
    })),
    updatedAt: new Date('2026-06-15T10:00:00Z')
  });

  assert.equal(result.clients.length, 1);
  assert.equal(result.clients[0].enabledPanels, 2);
  assert.equal(result.clients[0].totalPanels, 2);
  assert.equal(result.clients[0].usage.total, 10 * gib);
  assert.equal(result.clients[0].usage.used, 6 * gib);
  assert.equal(result.clients[0].usage.remaining, 4 * gib);
  assert.match(html, /6\.00 GB/);
  assert.doesNotMatch(html, /12\.00 GB/);
});

test('updates created clients while preserving untouched client fields', async () => {
  const gib = 1024 ** 3;
  const firstPanel = {
    name: 'first-panel',
    addClientUrl: 'https://first.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'direct',
    totalGbRatio: 1
  };
  const secondPanel = {
    name: 'second-panel',
    addClientUrl: 'https://second.example/secret/panel/api/inbounds/addClient',
    inboundId: '8',
    proxy: 'direct',
    totalGbRatio: 2
  };
  const firstClient = {
    id: '11111111-1111-4111-8111-111111111111',
    flow: '',
    email: 'shared-1',
    limitIp: 0,
    totalGB: 20 * gib,
    expiryTime: 0,
    enable: true,
    tgId: 0,
    subId: 'shared-sub',
    comment: 'keep me',
    reset: 0,
    created_at: 1780173876000,
    updated_at: 1780346404000
  };
  const secondClient = {
    ...firstClient,
    id: '22222222-2222-4222-8222-222222222222',
    email: 'shared-2',
    totalGB: 10 * gib
  };
  const firstInbound = {
    id: 4,
    settings: JSON.stringify({ clients: [firstClient] }),
    clientStats: [{ subId: 'shared-sub', uuid: firstClient.id, total: 20 * gib, allTime: 1 * gib }]
  };
  const secondInbound = {
    id: 8,
    settings: JSON.stringify({ clients: [secondClient] }),
    clientStats: [{ subId: 'shared-sub', uuid: secondClient.id, total: 10 * gib, allTime: 1 * gib }]
  };
  const updateRequests = [];
  const expiryTime = Date.parse('2026-07-01T12:30:00.000Z');
  const runtime = {
    async request(target, options) {
      if (target.url.endsWith('/list')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            obj: target.name === 'first-panel' ? [firstInbound] : [secondInbound]
          })
        };
      }

      updateRequests.push({
        panel: target.name,
        client: JSON.parse(options.body)
      });

      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          success: true,
          msg: 'Inbound client has been updated.',
          obj: null
        })
      };
    }
  };

  const result = await updateCreatedPanelClient(runtime, [firstPanel, secondPanel], {
    subId: 'shared-sub',
    status: 'disable',
    addGB: '4',
    expiryDate: '2026-07-01T12:30:00.000Z',
    clearExpiry: false
  });

  assert.equal(result.ok, true);
  assert.equal(updateRequests.length, 2);
  assert.equal(updateRequests[0].client.email, 'shared-1');
  assert.equal(updateRequests[1].client.email, 'shared-2');
  assert.equal(updateRequests[0].client.subId, undefined);
  assert.equal(updateRequests[1].client.subId, undefined);
  assert.equal(updateRequests[0].client.comment, 'keep me');
  assert.equal(updateRequests[0].client.created_at, 1780173876000);
  assert.equal(updateRequests[0].client.totalGB, 24 * gib);
  assert.equal(updateRequests[1].client.totalGB, 12 * gib);
  assert.equal(updateRequests[0].client.enable, false);
  assert.equal(updateRequests[1].client.enable, false);
  assert.equal(updateRequests[0].client.expiryTime, expiryTime);
  assert.equal(updateRequests[1].client.expiryTime, expiryTime);

  updateRequests.length = 0;
  const fixedNow = Date.parse('2026-06-11T10:00:00.000Z');
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const expiryResult = await updateCreatedPanelClient(runtime, [firstPanel, secondPanel], {
      subId: 'shared-sub',
      expiryAfterDays: '30'
    });

    assert.equal(expiryResult.ok, true);
  } finally {
    Date.now = originalNow;
  }

  const quickExpiryTime = fixedNow + 30 * 24 * 60 * 60 * 1000;
  assert.equal(updateRequests.length, 2);
  assert.equal(updateRequests[0].client.expiryTime, quickExpiryTime);
  assert.equal(updateRequests[1].client.expiryTime, quickExpiryTime);
  assert.equal(updateRequests[0].client.enable, true);
  assert.equal(updateRequests[1].client.enable, true);
});

test('updates clients through Xray panels before direct panels and skips direct after Xray failure', async () => {
  const gib = 1024 ** 3;
  const xrayPanel = {
    name: 'xray-panel',
    addClientUrl: 'https://xray.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'xray',
    totalGbRatio: 1
  };
  const directPanel = {
    name: 'direct-panel',
    addClientUrl: 'https://direct.example/secret/panel/api/inbounds/addClient',
    inboundId: '8',
    proxy: 'direct',
    totalGbRatio: 1
  };
  const xrayClient = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'shared-xray',
    subId: 'shared-sub',
    enable: true,
    totalGB: 5 * gib
  };
  const directClient = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'shared-direct',
    subId: 'shared-sub',
    enable: true,
    totalGB: 5 * gib
  };
  const xrayInbound = {
    id: 4,
    settings: JSON.stringify({ clients: [xrayClient] }),
    clientStats: [{ subId: 'shared-sub', uuid: xrayClient.id, total: 5 * gib, allTime: 1 * gib }]
  };
  const directInbound = {
    id: 8,
    settings: JSON.stringify({ clients: [directClient] }),
    clientStats: [{ subId: 'shared-sub', uuid: directClient.id, total: 5 * gib, allTime: 1 * gib }]
  };
  const updateRequests = [];
  const runtime = {
    async request(target, options) {
      if (target.url.endsWith('/list')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            obj: target.name === 'xray-panel' ? [xrayInbound] : [directInbound]
          })
        };
      }

      updateRequests.push(target.name);
      if (target.name === 'xray-panel') {
        throw new Error('xray update failed');
      }

      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, msg: 'updated', obj: null })
      };
    }
  };

  const result = await updateCreatedPanelClient(runtime, [xrayPanel, directPanel], {
    subId: 'shared-sub',
    status: 'disable'
  });

  assert.equal(result.ok, false);
  assert.deepEqual(updateRequests, ['xray-panel', 'xray-panel', 'xray-panel', 'xray-panel']);
  assert.match(result.results[0].error, /xray update failed after 4 attempts/);
  assert.equal(result.results[1].skipped, true);
  assert.match(result.results[1].error, /skipped after Xray failure/);
});

test('quota worker skips fully disabled groups and disables active groups on every panel', async () => {
  const gib = 1024 ** 3;
  const firstPanel = {
    name: 'first-panel',
    addClientUrl: 'https://first-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'direct'
  };
  const secondPanel = {
    name: 'second-panel',
    addClientUrl: 'https://second-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'direct'
  };
  const thirdPanel = {
    name: 'third-panel',
    addClientUrl: 'https://third-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '6',
    proxy: 'direct'
  };
  const activeFirst = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'active',
    subId: 'active-sub',
    enable: true,
    totalGB: 5 * gib
  };
  const activeSecond = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'active',
    subId: 'active-sub',
    enable: true,
    totalGB: 10 * gib
  };
  const activeThird = {
    id: '55555555-5555-4555-8555-555555555555',
    email: 'active',
    subId: 'active-sub',
    enable: true,
    totalGB: 20 * gib
  };
  const disabledFirst = {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'disabled',
    subId: 'disabled-sub',
    enable: false,
    totalGB: 5 * gib
  };
  const disabledSecond = {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'disabled',
    subId: 'disabled-sub',
    enable: false,
    totalGB: 10 * gib
  };
  const disabledThird = {
    id: '66666666-6666-4666-8666-666666666666',
    email: 'disabled',
    subId: 'disabled-sub',
    enable: false,
    totalGB: 20 * gib
  };
  const firstInbound = {
    id: 4,
    settings: JSON.stringify({ clients: [activeFirst, disabledFirst] }),
    clientStats: [
      { subId: 'active-sub', enable: true, total: 5 * gib, allTime: 2 * gib },
      { subId: 'disabled-sub', enable: false, total: 5 * gib, allTime: 5 * gib }
    ]
  };
  const secondInbound = {
    id: 4,
    settings: JSON.stringify({ clients: [activeSecond, disabledSecond] }),
    clientStats: [
      { subId: 'active-sub', enable: true, total: 10 * gib, allTime: 6 * gib },
      { subId: 'disabled-sub', enable: false, total: 10 * gib, allTime: 10 * gib }
    ]
  };
  const thirdInbound = {
    id: 6,
    settings: JSON.stringify({ clients: [activeThird, disabledThird] }),
    clientStats: [
      { subId: 'active-sub', enable: true, total: 20 * gib, allTime: 0 },
      { subId: 'disabled-sub', enable: false, total: 20 * gib, allTime: 20 * gib }
    ]
  };
  const requests = [];
  const runtime = {
    async request(target, options) {
      requests.push({ target, options });
      if (target.url.endsWith('/list')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            obj:
              target.name === 'first-panel'
                ? [firstInbound]
                : target.name === 'second-panel'
                  ? [secondInbound]
                  : [thirdInbound]
          })
        };
      }

      applyInboundClientUpdate(
        target.name === 'first-panel'
          ? firstInbound
          : target.name === 'second-panel'
            ? secondInbound
            : thirdInbound,
        options.body
      );
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          success: true,
          msg: 'Inbound client has been updated.',
          obj: null
        })
      };
    }
  };

  const result = await enforcePanelQuota(runtime, [firstPanel, secondPanel, thirdPanel], {
    concurrency: 2,
    logger: { log() {} }
  });
  const updateRequests = requests.filter((request) => request.options.method === 'POST');

  assert.equal(result.checked, 1);
  assert.equal(result.disabled.length, 1);
  assert.equal(result.partialDisabled.length, 0);
  assert.equal(result.disabled[0].subId, 'active-sub');
  assert.equal(result.skipped.some((item) => item.reason === 'already disabled'), true);
  assert.equal(updateRequests.length, 3);
});

test('quota worker reuses one list response for shared physical panel inbounds', async () => {
  const gib = 1024 ** 3;
  const basePanel = {
    addClientUrl: 'https://shared-panel.example/secret/panel/api/inbounds/addClient',
    cookie: 'session=shared',
    proxy: 'direct'
  };
  const firstPanel = {
    ...basePanel,
    name: 'shared first',
    inboundId: '4'
  };
  const secondPanel = {
    ...basePanel,
    name: 'shared second',
    inboundId: '5'
  };
  const firstInbound = {
    id: 4,
    settings: JSON.stringify({
      clients: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'shared',
          subId: 'shared-sub',
          enable: true,
          totalGB: 5 * gib
        }
      ]
    }),
    clientStats: [{ subId: 'shared-sub', enable: true, total: 5 * gib, allTime: 5 * gib }]
  };
  const secondInbound = {
    id: 5,
    settings: JSON.stringify({
      clients: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'shared',
          subId: 'shared-sub',
          enable: true,
          totalGB: 5 * gib
        }
      ]
    }),
    clientStats: [{ subId: 'shared-sub', enable: true, total: 5 * gib, allTime: 0 }]
  };
  const requests = [];
  const runtime = {
    async request(target, options) {
      requests.push({ target, options });
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, obj: [firstInbound, secondInbound] })
      };
    }
  };

  const result = await enforcePanelQuota(runtime, [firstPanel, secondPanel], {
    dryRun: true,
    logger: { log() {} }
  });

  assert.equal(result.checked, 1);
  assert.equal(result.disabled.length, 1);
  assert.equal(requests.filter((request) => request.target.url.endsWith('/list')).length, 1);
});

test('quota worker counts shared same-panel client usage once before enforcing', async () => {
  const gib = 1024 ** 3;
  const basePanel = {
    addClientUrl: 'https://shared-panel.example/secret/panel/api/inbounds/addClient',
    cookie: 'session=shared',
    proxy: 'direct'
  };
  const firstPanel = {
    ...basePanel,
    name: 'shared first',
    inboundId: '4'
  };
  const secondPanel = {
    ...basePanel,
    name: 'shared second',
    inboundId: '5'
  };
  const sharedClient = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'shared',
    subId: 'shared-sub',
    enable: true,
    totalGB: 10 * gib
  };
  const firstInbound = {
    id: 4,
    settings: JSON.stringify({ clients: [sharedClient] }),
    clientStats: [
      { email: 'shared', subId: 'shared-sub', enable: true, total: 10 * gib, allTime: 6 * gib }
    ]
  };
  const secondInbound = {
    id: 5,
    settings: JSON.stringify({ clients: [sharedClient] }),
    clientStats: [
      { email: 'shared', subId: 'shared-sub', enable: true, total: 10 * gib, allTime: 6 * gib }
    ]
  };
  const requests = [];
  const runtime = {
    async request(target, options) {
      requests.push({ target, options });
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, obj: [firstInbound, secondInbound] })
      };
    }
  };

  const result = await enforcePanelQuota(runtime, [firstPanel, secondPanel], {
    logger: { log() {} }
  });

  assert.equal(result.checked, 1);
  assert.equal(result.disabled.length, 0);
  assert.equal(result.partialDisabled.length, 0);
  assert.equal(requests.filter((request) => request.target.url.endsWith('/list')).length, 1);
  assert.equal(requests.filter((request) => request.options.method === 'POST').length, 0);
});

test('quota worker ignores subscription sources and uses panel stats', async () => {
  const gib = 1024 ** 3;
  const panel = {
    name: 'usage-panel',
    addClientUrl: 'https://usage-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'direct'
  };
  const belowClient = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'below',
    subId: 'below-sub',
    enable: true,
    totalGB: 10 * gib
  };
  const overClient = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'over',
    subId: 'over-sub',
    enable: true,
    totalGB: 10 * gib
  };
  const inbound = {
    id: 4,
    settings: JSON.stringify({ clients: [belowClient, overClient] }),
    clientStats: [
      { subId: 'below-sub', enable: true, total: 10 * gib, allTime: 12 * gib },
      { subId: 'over-sub', enable: true, total: 10 * gib, allTime: 0 }
    ]
  };
  const requests = [];
  const runtime = {
    async request(target, options) {
      requests.push({ target, options });
      if (target.url.endsWith('/list')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ success: true, obj: [inbound] })
        };
      }

      applyInboundClientUpdate(inbound, options.body);
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          success: true,
          msg: 'Inbound client has been updated.',
          obj: null
        })
      };
    },
    async fetch(source) {
      throw new Error(`unexpected subscription fetch for ${source.url}`);
    }
  };

  const result = await enforcePanelQuota(runtime, [panel], {
    sources: [{ name: 'authoritative', baseUrl: 'https://usage.example/sub', proxy: 'direct' }],
    logger: { log() {} }
  });
  const updateRequests = requests.filter((request) => request.options.method === 'POST');

  assert.equal(result.checked, 2);
  assert.deepEqual(result.disabled.map((item) => item.subId), ['below-sub']);
  assert.equal(result.partialDisabled.length, 0);
  assert.equal(updateRequests.length, 1);
  const updatedClient = JSON.parse(updateRequests[0].options.body);
  assert.equal(updatedClient.subId, undefined);
});

test('quota worker retries Xray disables and skips direct panels after Xray failure', async () => {
  const gib = 1024 ** 3;
  const xrayPanel = {
    name: 'xray-panel',
    addClientUrl: 'https://xray-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'xray'
  };
  const directPanel = {
    name: 'direct-panel',
    addClientUrl: 'https://direct-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '6',
    proxy: 'direct'
  };
  const xrayClient = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'active',
    subId: 'active-sub',
    enable: true,
    totalGB: 5 * gib
  };
  const directClient = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'active',
    subId: 'active-sub',
    enable: true,
    totalGB: 10 * gib
  };
  const xrayInbound = {
    id: 4,
    settings: JSON.stringify({ clients: [xrayClient] }),
    clientStats: [{ subId: 'active-sub', enable: true, total: 5 * gib, allTime: 5 * gib }]
  };
  const directInbound = {
    id: 6,
    settings: JSON.stringify({ clients: [directClient] }),
    clientStats: [{ subId: 'active-sub', enable: true, total: 10 * gib, allTime: 0 }]
  };
  const updateRequests = [];
  const runtime = {
    async request(target, options) {
      if (target.url.endsWith('/list')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            obj: target.name === 'xray-panel' ? [xrayInbound] : [directInbound]
          })
        };
      }

      updateRequests.push(target.name);
      if (target.name === 'xray-panel') {
        throw new Error('xray disable failed');
      }

      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, msg: 'updated', obj: null })
      };
    }
  };

  const result = await enforcePanelQuota(runtime, [xrayPanel, directPanel], {
    logger: { log() {} }
  });

  assert.equal(result.checked, 1);
  assert.equal(result.disabled.length, 0);
  assert.equal(result.partialDisabled.length, 0);
  assert.deepEqual(updateRequests, ['xray-panel', 'xray-panel', 'xray-panel', 'xray-panel']);
  assert.equal(result.skipped.some((item) => item.panel === 'direct-panel' && item.reason.includes('skipped after Xray failure')), true);
});

test('quota worker reports panels that were already disabled before an update', async () => {
  const gib = 1024 ** 3;
  const panels = [
    {
      name: 'aws',
      addClientUrl: 'https://aws.example/secret/panel/api/inbounds/addClient',
      inboundId: '4',
      proxy: 'direct'
    },
    {
      name: 'reverse',
      addClientUrl: 'https://reverse.example/secret/panel/api/inbounds/addClient',
      inboundId: '4',
      proxy: 'direct'
    },
    {
      name: 'cloudflare',
      addClientUrl: 'https://cloudflare.example/secret/panel/api/inbounds/addClient',
      inboundId: '4',
      proxy: 'direct'
    }
  ];
  const inboundFor = (id, email, enable, allTime) => ({
    id: 4,
    settings: JSON.stringify({
      clients: [
        {
          id,
          email,
          subId: 'mixed-sub',
          enable,
          totalGB: 5 * gib
        }
      ]
    }),
    clientStats: [{ subId: 'mixed-sub', enable, total: 5 * gib, allTime }]
  });
  const awsInbound = inboundFor('11111111-1111-4111-8111-111111111111', 'mixed-1', false, 6 * gib);
  const reverseInbound = inboundFor('22222222-2222-4222-8222-222222222222', 'mixed', true, 0);
  const cloudflareInbound = inboundFor('33333333-3333-4333-8333-333333333333', 'mixed-2', true, 0);
  const requests = [];
  const runtime = {
    async request(target, options) {
      requests.push({ target, options });
      if (target.url.endsWith('/list')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            obj:
              target.name === 'aws'
                ? [awsInbound]
                : target.name === 'reverse'
                  ? [reverseInbound]
                  : [cloudflareInbound]
          })
        };
      }

      applyInboundClientUpdate(
        target.name === 'aws'
          ? awsInbound
          : target.name === 'reverse'
            ? reverseInbound
            : cloudflareInbound,
        options.body
      );
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, msg: 'updated', obj: null })
      };
    }
  };

  const result = await enforcePanelQuota(runtime, panels, {
    logger: { log() {} }
  });
  const updatePanels = requests
    .filter((request) => request.options.method === 'POST')
    .map((request) => request.target.name);

  assert.equal(result.disabled.length, 1);
  assert.equal(result.partialDisabled.length, 0);
  assert.deepEqual(updatePanels, ['reverse', 'cloudflare']);
  assert.deepEqual(
    result.disabled[0].alreadyDisabledPanels.map((panel) => panel.panel),
    ['aws']
  );
  assert.deepEqual(
    result.disabled[0].panels.map((panel) => panel.panel),
    ['reverse', 'cloudflare']
  );
});

test('quota worker treats client settings enable as authoritative', async () => {
  const gib = 1024 ** 3;
  const panels = [
    {
      name: 'first-panel',
      addClientUrl: 'https://first-panel.example/secret/panel/api/inbounds/addClient',
      inboundId: '4',
      proxy: 'direct'
    },
    {
      name: 'second-panel',
      addClientUrl: 'https://second-panel.example/secret/panel/api/inbounds/addClient',
      inboundId: '4',
      proxy: 'direct'
    }
  ];
  const inboundFor = (id, email) => ({
    id: 4,
    settings: JSON.stringify({
      clients: [
        {
          id,
          email,
          subId: 'disabled-sub',
          enable: true,
          totalGB: 5 * gib
        }
      ]
    }),
    clientStats: [
      {
        subId: 'disabled-sub',
        enable: false,
        total: 5 * gib,
        allTime: 6 * gib
      }
    ]
  });
  const firstInbound = inboundFor('11111111-1111-4111-8111-111111111111', 'disabled-first');
  const secondInbound = inboundFor('22222222-2222-4222-8222-222222222222', 'disabled-second');
  const requests = [];
  const runtime = {
    async request(target, options) {
      requests.push({ target, options });
      if (!target.url.endsWith('/list')) {
        applyInboundClientUpdate(target.name === 'first-panel' ? firstInbound : secondInbound, options.body);
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ success: true, msg: 'updated', obj: null })
        };
      }

      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          success: true,
          obj: target.name === 'first-panel' ? [firstInbound] : [secondInbound]
        })
      };
    }
  };

  const result = await enforcePanelQuota(runtime, panels, {
    concurrency: 2,
    logger: { log() {} }
  });

  assert.equal(result.checked, 1);
  assert.equal(result.disabled.length, 1);
  assert.equal(result.partialDisabled.length, 0);
  assert.equal(result.disabled[0].subId, 'disabled-sub');
  assert.equal(result.skipped.some((item) => item.reason === 'already disabled'), false);
  assert.equal(requests.filter((request) => request.options.method === 'POST').length, 2);
});

test('quota worker retries direct panel disables before marking partial', async () => {
  const gib = 1024 ** 3;
  const firstPanel = {
    name: 'first-panel',
    addClientUrl: 'https://first-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'direct'
  };
  const secondPanel = {
    name: 'second-panel',
    addClientUrl: 'https://second-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'direct'
  };
  const firstInbound = {
    id: 4,
    settings: JSON.stringify({
      clients: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'retry',
          subId: 'retry-sub',
          enable: true,
          totalGB: 5 * gib
        }
      ]
    }),
    clientStats: [{ subId: 'retry-sub', enable: true, total: 5 * gib, allTime: 6 * gib }]
  };
  const secondInbound = {
    id: 4,
    settings: JSON.stringify({
      clients: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'retry',
          subId: 'retry-sub',
          enable: true,
          totalGB: 5 * gib
        }
      ]
    }),
    clientStats: [{ subId: 'retry-sub', enable: true, total: 5 * gib, allTime: 0 }]
  };
  const updateAttempts = new Map();
  const runtime = {
    async request(target, options) {
      if (target.url.endsWith('/list')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            obj: target.name === 'first-panel' ? [firstInbound] : [secondInbound]
          })
        };
      }

      const attempt = (updateAttempts.get(target.name) || 0) + 1;
      updateAttempts.set(target.name, attempt);
      if (target.name === 'second-panel' && attempt < 4) {
        throw new Error('temporary direct disable failed');
      }

      applyInboundClientUpdate(target.name === 'first-panel' ? firstInbound : secondInbound, options.body);
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, msg: 'updated', obj: null })
      };
    }
  };

  const result = await enforcePanelQuota(runtime, [firstPanel, secondPanel], {
    logger: { log() {} }
  });

  assert.equal(result.disabled.length, 1);
  assert.equal(result.partialDisabled.length, 0);
  assert.equal(result.disabled[0].subId, 'retry-sub');
  assert.equal(updateAttempts.get('first-panel'), 1);
  assert.equal(updateAttempts.get('second-panel'), 4);
});

test('quota worker verifies successful disable responses changed panel state', async () => {
  const gib = 1024 ** 3;
  const firstPanel = {
    name: 'first-panel',
    addClientUrl: 'https://first-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'direct'
  };
  const secondPanel = {
    name: 'second-panel',
    addClientUrl: 'https://second-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'direct'
  };
  const firstInbound = {
    id: 4,
    settings: JSON.stringify({
      clients: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'verify',
          subId: 'verify-sub',
          enable: true,
          totalGB: 5 * gib
        }
      ]
    }),
    clientStats: [{ subId: 'verify-sub', enable: true, total: 5 * gib, allTime: 6 * gib }]
  };
  const secondInbound = {
    id: 4,
    settings: JSON.stringify({
      clients: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'verify',
          subId: 'verify-sub',
          enable: true,
          totalGB: 5 * gib
        }
      ]
    }),
    clientStats: [{ subId: 'verify-sub', enable: true, total: 5 * gib, allTime: 0 }]
  };
  const updateAttempts = new Map();
  const runtime = {
    async request(target, options) {
      if (target.url.endsWith('/list')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            obj: target.name === 'first-panel' ? [firstInbound] : [secondInbound]
          })
        };
      }

      updateAttempts.set(target.name, (updateAttempts.get(target.name) || 0) + 1);
      if (target.name === 'first-panel') {
        applyInboundClientUpdate(firstInbound, options.body);
      }

      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, msg: 'updated', obj: null })
      };
    }
  };

  const result = await enforcePanelQuota(runtime, [firstPanel, secondPanel], {
    logger: { log() {} }
  });

  assert.equal(result.disabled.length, 0);
  assert.equal(result.partialDisabled.length, 1);
  assert.equal(result.partialDisabled[0].subId, 'verify-sub');
  assert.equal(result.partialDisabled[0].panels[0].panel, 'first-panel');
  assert.equal(result.partialDisabled[0].failed[0].panel, 'second-panel');
  assert.match(result.partialDisabled[0].failed[0].reason, /still active after update/);
  assert.equal(updateAttempts.get('first-panel'), 1);
  assert.equal(updateAttempts.get('second-panel'), 4);
});

test('quota worker logs partial disabled when only one panel update succeeds', async () => {
  const gib = 1024 ** 3;
  const firstPanel = {
    name: 'first-panel',
    addClientUrl: 'https://first-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'direct'
  };
  const secondPanel = {
    name: 'second-panel',
    addClientUrl: 'https://second-panel.example/secret/panel/api/inbounds/addClient',
    inboundId: '4',
    proxy: 'direct'
  };
  const firstInbound = {
    id: 4,
    settings: JSON.stringify({
      clients: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'partial',
          subId: 'partial-sub',
          enable: true,
          totalGB: 5 * gib
        }
      ]
    }),
    clientStats: [{ subId: 'partial-sub', enable: true, total: 5 * gib, allTime: 6 * gib }]
  };
  const secondInbound = {
    id: 4,
    settings: JSON.stringify({
      clients: [
        {
          email: 'partial',
          subId: 'partial-sub',
          enable: true,
          totalGB: 5 * gib
        }
      ]
    }),
    clientStats: [{ subId: 'partial-sub', enable: true, uuid: '', total: 5 * gib, allTime: 6 * gib }]
  };
  const logs = [];
  const runtime = {
    async request(target, options) {
      if (target.url.endsWith('/list')) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            obj: target.name === 'first-panel' ? [firstInbound] : [secondInbound]
          })
        };
      }

      if (target.name === 'first-panel') {
        applyInboundClientUpdate(firstInbound, options.body);
      }
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, msg: 'updated', obj: null })
      };
    }
  };

  const result = await enforcePanelQuota(runtime, [firstPanel, secondPanel], {
    concurrency: 2,
    logger: { log(message) { logs.push(message); } }
  });

  assert.equal(result.disabled.length, 0);
  assert.equal(result.partialDisabled.length, 1);
  assert.equal(result.partialDisabled[0].subId, 'partial-sub');
  assert.equal(result.partialDisabled[0].failed[0].panel, 'second-panel');
  assert.equal(logs.some((line) => /^quota worker runtime: \d+ms$/.test(line)), true);
  assert.equal(logs.some((line) => line.includes('processed clients: 1')), true);
  assert.equal(logs.some((line) => line.includes('partial disabled clients: 1')), true);
  assert.equal(logs.some((line) => line.startsWith('- partial')), false);
});

test('uses negative duration when start after first use is enabled', () => {
  const settings = buildClientSettings({
    clientId: '11111111-1111-4111-8111-111111111111',
    email: 'client@example.com',
    subId: 'clienttoken123',
    totalGB: '10',
    durationDays: '30',
    startAfterFirstUse: 'true',
    enable: 'false',
    comment: 'client note'
  });

  assert.equal(settings.clients[0].totalGB, 10 * 1024 ** 3);
  assert.equal(settings.clients[0].expiryTime, -30 * 24 * 60 * 60 * 1000);
  assert.equal(settings.clients[0].enable, false);
  assert.equal(settings.clients[0].comment, 'client note');
});

test('validates client settings form values', () => {
  assert.throws(() =>
    buildClientSettings({
      clientId: '11111111-1111-4111-8111-111111111111',
      email: '',
      subId: 'clienttoken123',
      totalGB: '10',
      durationDays: '30'
    })
  );
});

test('renders the inbound form with 3x-ui visible fields', () => {
  const html = renderInboundsPage({
    values: {
      clientId: '11111111-1111-4111-8111-111111111111',
      email: 'client@example.com',
      subId: 'clienttoken123',
      totalGB: '0',
      durationDays: '0',
      enable: 'true',
      startAfterFirstUse: 'false',
      comment: ''
    },
    subscription: {
      url: 'http://127.0.0.1:3000/sub/clienttoken123',
      base64Url: 'http://127.0.0.1:3000/sub/clienttoken123?format=base64',
      plainUrl: 'http://127.0.0.1:3000/sub/plain/clienttoken123'
    }
  });

  assert.match(html, /Enabled/);
  assert.match(html, /Email/);
  assert.match(html, /data-random-email/);
  assert.match(html, /Generate/);
  assert.match(html, /Comment/);
  assert.match(html, /Start After First Use/);
  assert.match(html, /Total Flow/);
  assert.match(html, /Aggregated Subscription/);
  assert.match(html, /http:\/\/127\.0\.0\.1:3000\/sub\/clienttoken123/);
  assert.match(html, /Base64/);
  assert.match(html, /Plain/);
  assert.match(html, /Streisand iOS/);
  assert.match(html, /V2Box iOS/);
  assert.match(html, /v2rayNG Android/);
  assert.match(html, /\/logos\/streisand\.jpg/);
  assert.match(html, /\/logos\/v2box\.jpg/);
  assert.match(html, /\/logos\/v2rayng\.png/);
  assert.match(html, /streisand:\/\/import\/http:\/\/127\.0\.0\.1:3000\/sub\/clienttoken123#Subscription/);
  assert.match(html, /v2box:\/\/install-sub\?url=http%3A%2F%2F127\.0\.0\.1%3A3000%2Fsub%2Fclienttoken123&amp;name=Subscription/);
  assert.match(html, /v2rayng:\/\/install-sub\?url=http%3A%2F%2F127\.0\.0\.1%3A3000%2Fsub%2Fclienttoken123&amp;name=Subscription/);
  assert.match(html, /data-copy-text=/);
  assert.match(html, /Click the URL to copy it/);
  assert.match(html, /\/assets\/inbounds\.js/);
  assert.doesNotMatch(html, /Telegram ID/);
  assert.doesNotMatch(html, /IP limit/);
});

test('renders the settings panel client controls', () => {
  const html = renderSettingsPage({
    databasePath: '/tmp/config.sqlite3',
    panels: [
      {
        id: 1,
        name: 'panel',
        add_client_url: 'https://panel.example/secret/panel/api/inbounds/addClient',
        cookie: '',
        proxy: 'direct',
        total_gb_ratio: 1.5,
        quota_divisor: 2,
        xtls_vision_flow: 1,
        enabled: 1,
        inboundCount: 1
      }
    ],
    inbounds: [
      {
        id: 1,
        panel_id: 1,
        panelName: 'panel',
        name: 'vision',
        inbound_id: '4',
        subscription_name: '',
        subscription_base_url: '',
        subscription_proxy: '',
        enabled: 1
      }
    ]
  });

  assert.match(html, /Total GB Ratio/);
  assert.match(html, /Quota Divisor/);
  assert.match(html, /XTLS Vision Flow/);
  assert.match(html, /name="xtlsVisionFlow"/);
  assert.match(html, /ratio 1\.5/);
  assert.match(html, /divisor 2/);
  assert.match(html, /XTLS vision flow/);
});

test('builds app links for subscription clients', () => {
  assert.deepEqual(
    subscriptionAppLinks('https://subscriptions.example/sub/client-token?format=base64', 'client token'),
    [
      {
        label: 'Streisand iOS',
        href: 'streisand://import/https://subscriptions.example/sub/client-token?format=base64#client%20token',
        icon: '/logos/streisand.jpg'
      },
      {
        label: 'V2Box iOS',
        href: 'v2box://install-sub?url=https%3A%2F%2Fsubscriptions.example%2Fsub%2Fclient-token%3Fformat%3Dbase64&name=client%20token',
        icon: '/logos/v2box.jpg'
      },
      {
        label: 'v2rayNG Android',
        href: 'v2rayng://install-sub?url=https%3A%2F%2Fsubscriptions.example%2Fsub%2Fclient-token%3Fformat%3Dbase64&name=client%20token',
        icon: '/logos/v2rayng.png'
      }
    ]
  );
});

test('checks optional basic admin auth', () => {
  const config = loadConfig(
    baseEnv({
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'secret',
      FIRST_PANEL_TOTAL_GB_RATIO: '1.5',
      FIRST_PANEL_QUOTA_DIVISOR: '2',
      SECOND_PANEL_TOTAL_GB_RATIO: '2',
      THIRD_PANEL_NAME: 'third-panel',
      THIRD_PANEL_ADD_CLIENT_URL: 'https://third-panel.example/secret/panel/api/inbounds/addClient',
      THIRD_PANEL_INBOUND_ID: '6',
      THIRD_PANEL_TOTAL_GB_RATIO: '3',
      THIRD_PANEL_CONFIG_COUNT: '4'
    })
  );

  const header = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
  assert.equal(isAuthorized(config, { headers: { authorization: header } }), true);
  assert.equal(isAuthorized(config, { headers: { authorization: 'Basic bad' } }), false);
  assert.equal(isAdminAuthorized(config, { headers: { authorization: header } }), true);
  assert.equal(isAdminAuthorized(loadConfig(baseEnv()), { headers: {} }), false);
  assert.equal(config.panels[0].totalGbRatio, 1.5);
  assert.equal(config.panels[0].quotaDivisor, 2);
  assert.equal(config.panels[1].totalGbRatio, 2);
  assert.equal(config.panels[1].quotaDivisor, 1);
  assert.equal(config.panels[2].name, 'third-panel');
  assert.equal(config.panels[2].inboundId, '6');
  assert.equal(config.panels[2].totalGbRatio, 3);
  assert.equal(config.panels[2].quotaDivisor, 4);
});

test('loads N panels and M inbounds from sqlite configuration', () => {
  const databasePath = path.join(mkdtempSync(path.join(tmpdir(), 'subscription-aggregator-')), 'config.sqlite3');
  const firstPanelId = createPanel(databasePath, {
    name: 'edge-panel',
    addClientUrl: 'https://edge-panel.example/secret/panel/api/inbounds/addClient',
    cookie: '3x-ui=edge',
    proxy: 'xray',
    totalGbRatio: '1.5',
    quotaDivisor: '2',
    xtlsVisionFlow: true,
    enabled: true
  });
  const secondPanelId = createPanel(databasePath, {
    name: 'core-panel',
    addClientUrl: 'https://core-panel.example/secret/panel/api/inbounds/addClient',
    cookie: '3x-ui=core',
    proxy: 'direct',
    totalGbRatio: '3',
    quotaDivisor: '4',
    enabled: true
  });

  createInbound(databasePath, {
    panelId: firstPanelId,
    name: 'edge-443',
    inboundId: '4',
    subscriptionName: 'edge 443',
    subscriptionBaseUrl: 'https://edge-provider.example/sub',
    subscriptionProxy: '',
    enabled: true
  });
  const disabledInboundId = createInbound(databasePath, {
    panelId: firstPanelId,
    name: 'edge-8443',
    inboundId: '5',
    subscriptionName: 'edge 8443',
    subscriptionBaseUrl: 'https://edge-provider-alt.example/sub',
    subscriptionProxy: 'direct',
    enabled: true
  });
  createInbound(databasePath, {
    panelId: secondPanelId,
    name: 'core-443',
    inboundId: '8',
    subscriptionName: 'core 443',
    subscriptionBaseUrl: 'https://core-provider.example/sub',
    subscriptionProxy: '',
    enabled: true
  });

  const config = loadConfig(
    baseEnv({
      SQLITE_DB_PATH: databasePath,
      FIRST_SUBSCRIPTION_BASE_URL: '',
      SECOND_SUBSCRIPTION_BASE_URL: ''
    })
  );
  assert.deepEqual(
    config.panels.map((panel) => ({
      name: panel.name,
      panelName: panel.panelName,
      inboundId: panel.inboundId,
      proxy: panel.proxy,
      totalGbRatio: panel.totalGbRatio,
      quotaDivisor: panel.quotaDivisor,
      clientFlow: panel.clientFlow
    })),
    [
      {
        name: 'edge-443',
        panelName: 'edge-panel',
        inboundId: '4',
        proxy: 'xray',
        totalGbRatio: 1.5,
        quotaDivisor: 2,
        clientFlow: 'xtls-rprx-vision'
      },
      {
        name: 'edge-8443',
        panelName: 'edge-panel',
        inboundId: '5',
        proxy: 'xray',
        totalGbRatio: 1.5,
        quotaDivisor: 2,
        clientFlow: 'xtls-rprx-vision'
      },
      {
        name: 'core-443',
        panelName: 'core-panel',
        inboundId: '8',
        proxy: 'direct',
        totalGbRatio: 3,
        quotaDivisor: 4,
        clientFlow: ''
      }
    ]
  );
  assert.deepEqual(
    config.sources.map((source) => ({
      name: source.name,
      baseUrl: source.baseUrl,
      proxy: source.proxy,
      totalGbRatio: source.totalGbRatio
    })),
    [
      {
        name: 'edge 443',
        baseUrl: 'https://edge-provider.example/sub',
        proxy: 'xray',
        totalGbRatio: 1.5
      },
      {
        name: 'edge 8443',
        baseUrl: 'https://edge-provider-alt.example/sub',
        proxy: 'direct',
        totalGbRatio: 1.5
      },
      {
        name: 'core 443',
        baseUrl: 'https://core-provider.example/sub',
        proxy: 'direct',
        totalGbRatio: 3
      }
    ]
  );

  const settings = loadSettingsData(databasePath);
  assert.equal(settings.panels.length, 2);
  assert.equal(settings.inbounds.length, 3);
  assert.equal(settings.panels[0].total_gb_ratio, 1.5);
  assert.equal(settings.panels[0].quota_divisor, 2);
  assert.equal(settings.panels[0].xtls_vision_flow, 1);

  updateInbound(databasePath, disabledInboundId, {
    panelId: firstPanelId,
    name: 'edge-8443',
    inboundId: '5',
    subscriptionName: 'edge 8443',
    subscriptionBaseUrl: 'https://edge-provider-alt.example/sub',
    subscriptionProxy: 'direct',
    enabled: false
  });
  refreshConfiguredTargets(config);

  assert.deepEqual(config.panels.map((panel) => panel.name), ['edge-443', 'core-443']);
  assert.deepEqual(config.sources.map((source) => source.name), ['edge 443', 'core 443']);
});

test('migrates legacy inbound client settings to panel settings', () => {
  const databasePath = path.join(mkdtempSync(path.join(tmpdir(), 'subscription-aggregator-')), 'config.sqlite3');
  const panelId = createPanel(databasePath, {
    name: 'legacy-panel',
    addClientUrl: 'https://legacy-panel.example/secret/panel/api/inbounds/addClient',
    proxy: 'direct',
    enabled: true
  });
  const firstInboundId = createInbound(databasePath, {
    panelId,
    name: 'legacy-443',
    inboundId: '4',
    subscriptionName: 'legacy 443',
    subscriptionBaseUrl: 'https://legacy-provider.example/sub',
    subscriptionProxy: '',
    enabled: true
  });
  const secondInboundId = createInbound(databasePath, {
    panelId,
    name: 'legacy-8443',
    inboundId: '5',
    subscriptionName: 'legacy 8443',
    subscriptionBaseUrl: 'https://legacy-provider-alt.example/sub',
    subscriptionProxy: '',
    enabled: true
  });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(`
      UPDATE panels
      SET total_gb_ratio = 1,
          quota_divisor = 1,
          xtls_vision_flow = 0
      WHERE id = ?
    `).run(panelId);
    db.prepare(`
      UPDATE inbounds
      SET total_gb_ratio = 2,
          quota_divisor = 3,
          xtls_vision_flow = 0
      WHERE id = ?
    `).run(firstInboundId);
    db.prepare(`
      UPDATE inbounds
      SET total_gb_ratio = 4,
          quota_divisor = 5,
          xtls_vision_flow = 1
      WHERE id = ?
    `).run(secondInboundId);
    db.prepare("DELETE FROM app_meta WHERE key = 'panel_client_settings_migrated'").run();
  } finally {
    db.close();
  }

  const config = loadConfig(
    baseEnv({
      SQLITE_DB_PATH: databasePath,
      FIRST_SUBSCRIPTION_BASE_URL: '',
      SECOND_SUBSCRIPTION_BASE_URL: ''
    })
  );
  const settings = loadSettingsData(databasePath);

  assert.equal(settings.panels[0].total_gb_ratio, 2);
  assert.equal(settings.panels[0].quota_divisor, 3);
  assert.equal(settings.panels[0].xtls_vision_flow, 1);
  assert.deepEqual(
    config.panels.map((panel) => ({
      name: panel.name,
      totalGbRatio: panel.totalGbRatio,
      quotaDivisor: panel.quotaDivisor,
      clientFlow: panel.clientFlow
    })),
    [
      {
        name: 'legacy-443',
        totalGbRatio: 2,
        quotaDivisor: 3,
        clientFlow: 'xtls-rprx-vision'
      },
      {
        name: 'legacy-8443',
        totalGbRatio: 2,
        quotaDivisor: 3,
        clientFlow: 'xtls-rprx-vision'
      }
    ]
  );
});

test('merges sqlite subscription sources with non-duplicate env sources', () => {
  const databasePath = path.join(mkdtempSync(path.join(tmpdir(), 'subscription-aggregator-')), 'config.sqlite3');
  const firstPanelId = createPanel(databasePath, {
    name: 'source-panel',
    addClientUrl: 'https://source-panel.example/secret/panel/api/inbounds/addClient',
    proxy: 'direct',
    totalGbRatio: '1',
    enabled: true
  });
  const extraPanelId = createPanel(databasePath, {
    name: 'source-extra-panel',
    addClientUrl: 'https://source-extra-panel.example/secret/panel/api/inbounds/addClient',
    proxy: 'direct',
    totalGbRatio: '0.5',
    enabled: true
  });

  createInbound(databasePath, {
    panelId: firstPanelId,
    name: 'db-first',
    inboundId: '1',
    subscriptionName: 'db first',
    subscriptionBaseUrl: 'https://first-provider.example/sub',
    subscriptionProxy: 'xray',
    enabled: true
  });
  createInbound(databasePath, {
    panelId: extraPanelId,
    name: 'db-extra',
    inboundId: '2',
    subscriptionName: 'db extra',
    subscriptionBaseUrl: 'https://db-extra.example/sub',
    subscriptionProxy: 'direct',
    enabled: true
  });

  const config = loadConfig(baseEnv({ SQLITE_DB_PATH: databasePath }));

  assert.deepEqual(
    config.sources.map((source) => ({
      name: source.name,
      baseUrl: source.baseUrl,
      proxy: source.proxy,
      totalGbRatio: source.totalGbRatio
    })),
    [
      {
        name: 'db first',
        baseUrl: 'https://first-provider.example/sub',
        proxy: 'xray',
        totalGbRatio: 1
      },
      {
        name: 'db extra',
        baseUrl: 'https://db-extra.example/sub',
        proxy: 'direct',
        totalGbRatio: 0.5
      },
      {
        name: 'nimcloud',
        baseUrl: 'https://second-provider.example/sub',
        proxy: 'direct',
        totalGbRatio: undefined
      }
    ]
  );
});

test('legacy panel migration is not marked done before legacy panel env exists', () => {
  const databasePath = path.join(mkdtempSync(path.join(tmpdir(), 'subscription-aggregator-')), 'config.sqlite3');

  loadConfig(
    baseEnv({
      SQLITE_DB_PATH: databasePath,
      FIRST_SUBSCRIPTION_BASE_URL: '',
      SECOND_SUBSCRIPTION_BASE_URL: ''
    })
  );
  assert.equal(loadSettingsData(databasePath).panels.length, 0);

  const config = loadConfig(
    baseEnv({
      SQLITE_DB_PATH: databasePath,
      FIRST_SUBSCRIPTION_BASE_URL: '',
      SECOND_SUBSCRIPTION_BASE_URL: '',
      FIRST_PANEL_NAME: 'late-panel',
      FIRST_PANEL_ADD_CLIENT_URL: 'https://late-panel.example/secret/panel/api/inbounds/addClient',
      FIRST_PANEL_INBOUND_ID: '9',
      FIRST_PANEL_PROXY: 'direct'
    })
  );

  const settings = loadSettingsData(databasePath);
  assert.equal(settings.panels.length, 1);
  assert.equal(settings.inbounds.length, 1);
  assert.equal(config.panels[0].name, 'late-panel');
  assert.equal(config.panels[0].inboundId, '9');
});

test('builds source URLs from base URLs and a route token', () => {
  assert.equal(
    buildSourceUrl('https://first-provider.example/sub', 'client-token'),
    'https://first-provider.example/sub/client-token'
  );

  assert.equal(
    buildSourceUrl('https://first-provider.example/sub/', 'token with spaces'),
    'https://first-provider.example/sub/token%20with%20spaces'
  );

  assert.deepEqual(
    sourcesForToken(
      [
        {
          name: 'first',
          baseUrl: 'https://first-provider.example/sub',
          proxy: 'xray'
        }
      ],
      'abc123'
    ),
    [
      {
        name: 'first',
        baseUrl: 'https://first-provider.example/sub',
        proxy: 'xray',
        url: 'https://first-provider.example/sub/abc123'
      }
    ]
  );
});

test('rejects route tokens with path separators', () => {
  assert.throws(() => buildSourceUrl('https://first-provider.example/sub', 'a/b'));
});

test('parses subscription usage headers', () => {
  const usage = parseSubscriptionUserInfo(
    'upload=1024; download=3072; total=8192; expire=1790000000'
  );

  assert.equal(usage.upload, 1024);
  assert.equal(usage.download, 3072);
  assert.equal(usage.used, 4096);
  assert.equal(usage.total, 8192);
  assert.equal(usage.remaining, 4096);
  assert.equal(formatBytes(usage.remaining), '4.00 KB');
});

test('does not divide quota by link count when one panel returns multiple links', () => {
  const usage = usageFromResult({
    count: 2,
    headers: {
      'subscription-userinfo': 'upload=2048; download=2048; total=16384; expire=0'
    }
  });
  const summary = summarizeUsage([
    {
      count: 2,
      headers: {
        'subscription-userinfo': 'upload=2048; download=2048; total=16384; expire=0'
      }
    },
    {
      count: 1,
      headers: {
        'subscription-userinfo': 'upload=1024; download=1024; total=8192; expire=0'
      }
    }
  ]);
  const normalizedSummary = summarizeNormalizedUsage([
    {
      count: 2,
      headers: {
        'subscription-userinfo': 'upload=2048; download=2048; total=16384; expire=0'
      }
    },
    {
      count: 1,
      headers: {
        'subscription-userinfo': 'upload=1024; download=1024; total=8192; expire=0'
      }
    }
  ]);

  // subscription-userinfo reports total quota for the client, not per-link quota.
  // count (number of links returned) must not divide the quota or usage.
  assert.equal(usage.upload, 2048);
  assert.equal(usage.download, 2048);
  assert.equal(usage.used, 4096);
  assert.equal(usage.total, 16384);
  assert.equal(usage.remaining, 12288);
  assert.equal(summary.upload, 3072);
  assert.equal(summary.download, 3072);
  assert.equal(summary.used, 6144);
  assert.equal(summary.total, 24576);
  assert.equal(summary.remaining, 18432);
  assert.equal(normalizedSummary.hasData, true);
  assert.equal(normalizedSummary.used, 8192);
  assert.equal(normalizedSummary.total, 16384);
  assert.equal(normalizedSummary.remaining, 8192);
});

test('counts same-panel subscription usage once when one client has multiple inbound links', () => {
  const gib = 1024 ** 3;
  const normalizedSummary = summarizeNormalizedUsage([
    {
      count: 1,
      source: { name: 'cdn 443', panelDbId: 10, totalGbRatio: 1 },
      headers: {
        'subscription-userinfo': `upload=${2 * gib}; download=${4 * gib}; total=${10 * gib}; expire=0`
      }
    },
    {
      count: 1,
      source: { name: 'cdn 8443', panelDbId: 10, totalGbRatio: 1 },
      headers: {
        'subscription-userinfo': `upload=${2 * gib}; download=${4 * gib}; total=${10 * gib}; expire=0`
      }
    }
  ]);

  assert.equal(normalizedSummary.hasData, true);
  assert.equal(normalizedSummary.used, 6 * gib);
  assert.equal(normalizedSummary.total, 10 * gib);
  assert.equal(normalizedSummary.remaining, 4 * gib);
});

test('normalizes aggregated subscription usage back to base ratio units', () => {
  const result = {
    count: 1,
    source: { name: 'discount-ratio-panel', totalGbRatio: 0.5 },
    headers: {
      'subscription-userinfo': 'upload=2147483648; download=3221225472; total=21474836480; expire=0'
    }
  };

  const sourceUsage = usageFromResult(result);
  const normalizedSummary = summarizeNormalizedUsage([result]);

  assert.equal(sourceUsage.used, 5 * 1024 ** 3);
  assert.equal(sourceUsage.total, 20 * 1024 ** 3);
  assert.equal(normalizedSummary.used, 2.5 * 1024 ** 3);
  assert.equal(normalizedSummary.total, 10 * 1024 ** 3);
  assert.equal(normalizedSummary.remaining, 7.5 * 1024 ** 3);
});

test('renders a local QR SVG', () => {
  const svg = renderQrSvg('http://127.0.0.1:3000/sub/client-token');

  assert.match(svg, /^<svg /);
  assert.match(svg, /<rect /);
  assert.match(svg, /Subscription QR code/);
});

test('renders subscription info page with app links and copy targets', () => {
  const html = renderSubscriptionPage({
    token: 'client-token',
    subscriptionUrl: 'http://127.0.0.1:3000/sub/client-token',
    base64Url: 'http://127.0.0.1:3000/sub/client-token?format=base64',
    plainUrl: 'http://127.0.0.1:3000/sub/plain/client-token',
    updatedAt: new Date('2026-05-30T12:34:56Z'),
    result: {
      links: ['vless://user@example.com:443?security=tls#example'],
      results: [
        {
          source: { name: 'first', proxy: 'xray' },
          count: 1,
          headers: {
            'subscription-userinfo': 'upload=1024; download=3072; total=8192; expire=0'
          }
        },
        {
          source: { name: 'second', proxy: 'direct' },
          count: 1,
          headers: {
            'subscription-userinfo': 'upload=2048; download=2048; total=16384; expire=0'
          }
        }
      ]
    }
  });

  assert.match(html, /Subscription Info/);
  assert.match(html, /first/);
  assert.match(html, /second/);
  assert.match(html, /QR code/);
  assert.match(html, /Last updated:/);
  assert.match(html, /Please update your subscription link daily/);
  assert.match(html, /Aggregated Remaining/);
  assert.match(html, /2\.00 KB/);
  assert.match(html, /http:\/\/127\.0\.0\.1:3000\/sub\/client-token/);
  assert.match(html, /Streisand iOS/);
  assert.match(html, /V2Box iOS/);
  assert.match(html, /v2rayNG Android/);
  assert.match(html, /\/logos\/streisand\.jpg/);
  assert.match(html, /Tap the URL to copy it/);
  assert.match(html, /data-copy-text="http:\/\/127\.0\.0\.1:3000\/sub\/client-token"/);
  assert.match(html, /data-copy-text="vless:\/\/user@example\.com:443\?security=tls#example"/);
  assert.match(html, /\/assets\/copy\.js/);
  assert.doesNotMatch(html, /\/assets\/inbounds\.js/);
});

test('builds an xray local HTTP inbound with a VLESS WS TLS outbound', () => {
  const config = buildXrayConfigFromVlessLink(
    'vless://11111111-1111-4111-8111-111111111111@proxy.example:443?type=ws&encryption=none&path=%2F&host=edge.example&security=tls&fp=chrome&alpn=h2%2Chttp%2F1.1&sni=tls.example#test-proxy',
    10808
  );

  assert.equal(config.inbounds[0].protocol, 'http');
  assert.equal(config.inbounds[0].listen, '127.0.0.1');
  assert.equal(config.inbounds[0].port, 10808);
  assert.equal(config.outbounds[0].protocol, 'vless');
  assert.equal(config.outbounds[0].settings.vnext[0].address, 'proxy.example');
  assert.equal(config.outbounds[0].settings.vnext[0].port, 443);
  assert.equal(config.outbounds[0].settings.vnext[0].users[0].encryption, 'none');
  assert.equal(config.outbounds[0].streamSettings.network, 'ws');
  assert.equal(config.outbounds[0].streamSettings.security, 'tls');
  assert.equal(config.outbounds[0].streamSettings.wsSettings.path, '/');
  assert.equal(config.outbounds[0].streamSettings.wsSettings.headers.Host, 'edge.example');
  assert.equal(config.outbounds[0].streamSettings.tlsSettings.serverName, 'tls.example');
  assert.deepEqual(config.outbounds[0].streamSettings.tlsSettings.alpn, ['h2', 'http/1.1']);
  assert.equal(config.outbounds[0].streamSettings.tlsSettings.fingerprint, 'chrome');
});

test('builds an xray VLESS XHTTP TLS outbound', () => {
  const config = buildXrayConfigFromVlessLink(
    'vless://5cb55313-824f-4315-aab9-bd9032fade8b@ip2.feywebsite.ir:2087?encryption=none&type=xhttp&mode=auto&host=sn1.asukasimp.com&security=tls&fp=chrome&sni=sn1.asukasimp.com&alpn=h2#FeyVPN%25F0%259F%2587%25AB%25F0%259F%2587%25AE',
    10808
  );

  assert.equal(config.outbounds[0].settings.vnext[0].address, 'ip2.feywebsite.ir');
  assert.equal(config.outbounds[0].settings.vnext[0].port, 2087);
  assert.equal(config.outbounds[0].settings.vnext[0].users[0].id, '5cb55313-824f-4315-aab9-bd9032fade8b');
  assert.equal(config.outbounds[0].settings.vnext[0].users[0].encryption, 'none');
  assert.equal(config.outbounds[0].streamSettings.network, 'xhttp');
  assert.equal(config.outbounds[0].streamSettings.security, 'tls');
  assert.equal(config.outbounds[0].streamSettings.xhttpSettings.path, '/');
  assert.equal(config.outbounds[0].streamSettings.xhttpSettings.host, 'sn1.asukasimp.com');
  assert.equal(config.outbounds[0].streamSettings.xhttpSettings.mode, 'auto');
  assert.equal(config.outbounds[0].streamSettings.tlsSettings.serverName, 'sn1.asukasimp.com');
  assert.deepEqual(config.outbounds[0].streamSettings.tlsSettings.alpn, ['h2']);
  assert.equal(config.outbounds[0].streamSettings.tlsSettings.fingerprint, 'chrome');
});

test('builds an xray VLESS TCP REALITY outbound', () => {
  const config = buildXrayConfigFromVlessLink(
    'vless://11111111-1111-4111-8111-111111111111@reality.example:443?encryption=none&fp=chrome&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&security=reality&sid=abcdef&sni=www.example.com&spx=%2Fspider&type=tcp#test-reality',
    10808
  );

  assert.equal(config.outbounds[0].settings.vnext[0].address, 'reality.example');
  assert.equal(config.outbounds[0].settings.vnext[0].port, 443);
  assert.equal(config.outbounds[0].streamSettings.network, 'tcp');
  assert.equal(config.outbounds[0].streamSettings.security, 'reality');
  assert.equal(config.outbounds[0].streamSettings.realitySettings.serverName, 'www.example.com');
  assert.equal(
    config.outbounds[0].streamSettings.realitySettings.publicKey,
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  );
  assert.equal(config.outbounds[0].streamSettings.realitySettings.shortId, 'abcdef');
  assert.equal(config.outbounds[0].streamSettings.realitySettings.spiderX, '/spider');
  assert.equal(config.outbounds[0].streamSettings.realitySettings.fingerprint, 'chrome');
});
