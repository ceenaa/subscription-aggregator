import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDotEnv } from '../src/env.js';
import {
  aggregateSubscriptions,
  decodeSubscriptionText,
  encodeSubscriptionLinks,
  extractSubscriptionLinks
} from '../src/subscription.js';
import { buildXrayConfigFromVlessLink } from '../src/xray.js';
import { buildSourceUrl, sourcesForToken } from '../src/source-url.js';
import { renderQrSvg } from '../src/qr.js';
import { renderSubscriptionPage } from '../src/page.js';
import { formatBytes, parseSubscriptionUserInfo } from '../src/usage.js';

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

test('renders a local QR SVG', () => {
  const svg = renderQrSvg('http://127.0.0.1:3000/sub/client-token');

  assert.match(svg, /^<svg /);
  assert.match(svg, /<rect /);
  assert.match(svg, /Subscription QR code/);
});

test('renders subscription info page without external assets', () => {
  const html = renderSubscriptionPage({
    token: 'client-token',
    subscriptionUrl: 'http://127.0.0.1:3000/sub/client-token',
    base64Url: 'http://127.0.0.1:3000/sub/client-token?format=base64',
    plainUrl: 'http://127.0.0.1:3000/sub/plain/client-token',
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
  assert.match(html, /http:\/\/127\.0\.0\.1:3000\/sub\/client-token/);
  assert.doesNotMatch(html, /<script/i);
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
