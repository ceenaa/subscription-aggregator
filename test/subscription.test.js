import assert from 'node:assert/strict';
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
import { subscriptionAppLinks } from '../src/app-links.js';
import {
  formatBytes,
  normalizeCombinedUsage,
  parseSubscriptionUserInfo,
  summarizeNormalizedUsage,
  summarizeUsage,
  usageFromResult
} from '../src/usage.js';
import { loadConfig } from '../src/config.js';
import { buildResponseHeaders } from '../src/response-headers.js';
import { getRequestOrigin } from '../src/url-context.js';
import { addClientToPanels, buildAddClientRequest, buildClientSettings } from '../src/panel-client.js';
import { isAuthorized } from '../src/auth.js';
import {
  buildListInboundsRequest,
  buildUpdateClientRequest,
  enforcePanelQuota,
  evaluateQuotaPair,
  indexInboundClients
} from '../src/quota-worker.js';

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

test('builds 3x-ui addClient form requests without real panel values', () => {
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
  const body = new URLSearchParams(request.body);
  const settings = JSON.parse(body.get('settings'));

  assert.equal(body.get('id'), '4');
  assert.equal(settings.clients[0].id, input.clientId);
  assert.equal(settings.clients[0].email, input.email);
  assert.equal(settings.clients[0].subId, input.subId);
  assert.equal(settings.clients[0].totalGB, 0);
  assert.equal(settings.clients[0].expiryTime, 0);
  assert.equal(settings.clients[0].enable, true);
  assert.equal(settings.clients[0].limitIp, 0);
  assert.equal(settings.clients[0].tgId, '');
  assert.equal(settings.clients[0].comment, '');
  assert.equal(request.headers.Cookie, panel.cookie);
  assert.equal(request.headers.Origin, 'https://panel.example');
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

test('adds email suffixes when creating clients on duplicate panel URLs', async () => {
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
  const runtime = {
    async request() {
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ success: true, obj: null })
      };
    }
  };

  const results = await addClientToPanels(runtime, panels, input);

  assert.deepEqual(
    results.map((result) => result.request.settings.clients[0].email),
    ['client@example.com-1', 'client@example.com-2', 'client@example.com']
  );
  assert.equal(input.email, 'client@example.com');
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
  const updateRequest = buildUpdateClientRequest(panel, inbound, client);
  const updateBody = new URLSearchParams(updateRequest.body);
  const settings = JSON.parse(updateBody.get('settings'));

  assert.equal(listRequest.url, 'https://panel.example/secret/panel/api/inbounds/list');
  assert.equal(listRequest.headers.Cookie, panel.cookie);
  assert.equal(updateRequest.url, 'https://panel.example/secret/panel/api/inbounds/updateClient/11111111-1111-4111-8111-111111111111');
  assert.equal(updateBody.get('id'), '4');
  assert.equal(settings.clients[0].enable, false);
  assert.equal(settings.clients[0].totalGB, 5 * 1024 ** 3);
  assert.equal(updateRequest.headers.Origin, 'https://panel.example');
});

test('indexes inbound clients and evaluates ratio quota conditions', () => {
  const panel = { name: 'first-panel' };
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

test('quota worker treats clientStats enable as authoritative', async () => {
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
  const requests = [];
  const runtime = {
    async request(target, options) {
      requests.push({ target, options });
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          success: true,
          obj:
            target.name === 'first-panel'
              ? [inboundFor('11111111-1111-4111-8111-111111111111', 'disabled-first')]
              : [inboundFor('22222222-2222-4222-8222-222222222222', 'disabled-second')]
        })
      };
    }
  };

  const result = await enforcePanelQuota(runtime, panels, {
    concurrency: 2,
    logger: { log() {} }
  });

  assert.equal(result.checked, 0);
  assert.equal(result.disabled.length, 0);
  assert.equal(result.partialDisabled.length, 0);
  assert.equal(result.skipped.some((item) => item.reason === 'already disabled'), true);
  assert.equal(requests.filter((request) => request.options.method === 'POST').length, 0);
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
  assert.equal(logs.some((line) => line.includes('partial disabled clients: 1')), true);
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
      SECOND_PANEL_TOTAL_GB_RATIO: '2',
      THIRD_PANEL_NAME: 'third-panel',
      THIRD_PANEL_ADD_CLIENT_URL: 'https://third-panel.example/secret/panel/api/inbounds/addClient',
      THIRD_PANEL_INBOUND_ID: '6',
      THIRD_PANEL_TOTAL_GB_RATIO: '3'
    })
  );

  const header = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
  assert.equal(isAuthorized(config, { headers: { authorization: header } }), true);
  assert.equal(isAuthorized(config, { headers: { authorization: 'Basic bad' } }), false);
  assert.equal(config.panels[0].totalGbRatio, 1.5);
  assert.equal(config.panels[1].totalGbRatio, 2);
  assert.equal(config.panels[2].name, 'third-panel');
  assert.equal(config.panels[2].inboundId, '6');
  assert.equal(config.panels[2].totalGbRatio, 3);
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

test('normalizes only the quota when one panel returns multiple links', () => {
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

  assert.equal(usage.upload, 2048);
  assert.equal(usage.download, 2048);
  assert.equal(usage.used, 4096);
  assert.equal(usage.total, 8192);
  assert.equal(usage.remaining, 4096);
  assert.equal(summary.upload, 3072);
  assert.equal(summary.download, 3072);
  assert.equal(summary.used, 6144);
  assert.equal(summary.total, 16384);
  assert.equal(summary.remaining, 10240);
  assert.equal(normalizedSummary.hasData, true);
  assert.equal(normalizedSummary.used, 6144);
  assert.equal(normalizedSummary.total, 8192);
  assert.equal(normalizedSummary.remaining, 2048);
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
