import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { requestResponseDirect, requestResponseViaHttpProxy, closeProxyConnections } from '../src/http-client.js';
import { createSnapshotCache } from '../src/snapshot-cache.js';
import { clientsPagination } from '../src/clients-pagination.js';
import { listCreatedPanelClients } from '../src/panel-clients.js';
import { sendCompressed } from '../src/compressed-response.js';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const stop = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Network integration tests deliberately fail when local sockets are unavailable.
// Run the suite with local network permission for release validation.
test('decodes compressed fragmented responses and reuses direct connections', async () => {
  let connections = 0;
  const body = JSON.stringify({ clients: Array.from({ length: 1000 }, (_, n) => `client-${n}`) });
  const server = http.createServer((req, res) => {
    assert.match(req.headers['accept-encoding'], /gzip/);
    const br = req.url === '/br';
    const encoded = br ? brotliCompressSync(body) : gzipSync(body);
    res.writeHead(200, { 'Content-Encoding': br ? 'br' : 'gzip' });
    res.write(encoded.subarray(0, 13));
    setTimeout(() => res.end(encoded.subarray(13)), 5);
  });
  server.on('connection', () => connections++);
  const port = await listen(server);
  try {
    assert.equal((await requestResponseDirect(`http://127.0.0.1:${port}/gzip`)).body, body);
    assert.equal((await requestResponseDirect(`http://127.0.0.1:${port}/br`)).body, body);
    assert.equal(connections, 1);
  } finally { await stop(server); }
});

test('HTTPS proxy decodes chunked gzip without waiting for close and pools CONNECT tunnels', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aggregator-tls-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key'), '-out', path.join(dir, 'cert'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const ca = readFileSync(path.join(dir, 'cert'));
  const origin = https.createServer({ key: readFileSync(path.join(dir, 'key')), cert: ca }, (req, res) => {
    const zipped = gzipSync('compressed proxy response');
    res.writeHead(200, { 'Content-Encoding': 'gzip' });
    res.write(zipped.subarray(0, 7));
    setTimeout(() => res.end(zipped.subarray(7)), 5);
  });
  const sockets = new Set();
  let tunnels = 0;
  const proxy = http.createServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels++;
    const upstream = net.connect(Number(req.url.split(':').at(-1)), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    for (const item of [socket, upstream]) {
      sockets.add(item);
      item.on('error', () => { socket.destroy(); upstream.destroy(); });
      item.on('close', () => { sockets.delete(item); socket.destroy(); upstream.destroy(); });
    }
  });
  const originPort = await listen(origin);
  const proxyPort = await listen(proxy);
  try {
    for (let n = 0; n < 2; n++) {
      const response = await requestResponseViaHttpProxy(`https://localhost:${originPort}/`, { proxyPort, ca, timeoutMs: 3000 });
      assert.equal(response.body, 'compressed proxy response');
    }
    assert.equal(tunnels, 1);
    await assert.rejects(requestResponseViaHttpProxy(`https://localhost:${originPort}/`, { proxyPort, timeoutMs: 3000 }), /self-signed|certificate/i);
  } finally {
    closeProxyConnections(proxyPort);
    for (const socket of sockets) socket.destroy();
    await Promise.all([stop(origin), stop(proxy)]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one HTTP deadline covers redirects and a continuously streaming body', async () => {
  const intervals = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') return setTimeout(() => { res.writeHead(302, { Location: '/stream' }); res.end(); }, 40);
    const timer = setInterval(() => res.write('a'), 5);
    intervals.add(timer);
    res.on('close', () => { clearInterval(timer); intervals.delete(timer); });
  });
  const port = await listen(server);
  const started = Date.now();
  try {
    await assert.rejects(requestResponseDirect(`http://127.0.0.1:${port}/redirect`, { maxRedirects: 2, timeoutMs: 90 }), /timed out/);
    assert.ok(Date.now() - started < 500);
  } finally { for (const timer of intervals) clearInterval(timer); await stop(server); }
});

test('response compression respects q=0, preserves Vary and sends no HEAD body', async () => {
  const body = 'private clients '.repeat(1000);
  const server = http.createServer((req, res) => sendCompressed({ cors: { origins: ['https://app.example'] } }, req, res, 200, body, 'text/html'));
  const port = await listen(server);
  async function read(encoding, method = 'GET') {
    return new Promise((resolve, reject) => {
      http.request(`http://127.0.0.1:${port}`, { method, headers: { 'Accept-Encoding': encoding, Origin: 'https://app.example' } }, res => {
        const chunks = []; res.on('data', x => chunks.push(x));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject).end();
    });
  }
  try {
    const compressed = await read('gzip');
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.ok(compressed.body.length < 200);
    assert.match(compressed.headers.vary, /Origin.*Accept.*Accept-Encoding/);
    assert.equal(compressed.headers['cache-control'], 'no-store');
    const identity = await read('gzip;q=0, *;q=1');
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.equal(identity.body.toString(), body);
    assert.equal((await read('gzip', 'HEAD')).body.length, 0);
  } finally { await stop(server); }
});

test('snapshots coalesce concurrent reads and retain last success after refresh failure', async () => {
  let time = 1000, calls = 0;
  let next = deferred();
  const cache = createSnapshotCache({ now: () => time, ttlMs: 100, maxStaleMs: 1000, load: () => { calls++; return next.promise; } });
  const first = cache.get('a'), second = cache.get('a');
  await tick(); assert.equal(calls, 1);
  next.resolve({ clients: ['one'] });
  await Promise.all([first, second]);
  time += 101;
  next = deferred();
  const stale = await cache.get('a');
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.data.clients, ['one']);
  await tick(); assert.equal(calls, 2);
  next.reject(new Error('panel unavailable'));
  await tick();
  const warning = await cache.get('a');
  assert.match(warning.refreshError, /panel unavailable/);
  await tick();
  time += 1001;
  await assert.rejects(cache.get('a'), /panel unavailable/);
});

test('an edit invalidates old in-flight refreshes and a changed configuration loads separately', async () => {
  const pending = [];
  const cache = createSnapshotCache({ load: () => { const d = deferred(); pending.push(d); return d.promise; } });
  const old = cache.get('a'); await tick();
  cache.invalidate();
  const edited = cache.get('a'); await tick();
  pending[1].resolve('after edit'); await edited;
  pending[0].resolve('before edit'); await old;
  assert.equal((await cache.get('a')).data, 'after edit');
  const changed = cache.get('b'); await tick();
  pending[2].resolve('new config');
  assert.equal((await changed).data, 'new config');
});

test('pagination searches the complete joined snapshot, bounds page sizes and escapes query links', () => {
  const clients = Array.from({ length: 696 }, (_, n) => ({ email: `client-${n}`, subId: `sub-${n}` }));
  const first = clientsPagination(clients, new URL('https://example/clients'));
  assert.equal(first.items.length, 50); assert.equal(first.pages, 14);
  const search = clientsPagination(clients, new URL('https://example/clients?q=SUB-695&page=999&pageSize=999'));
  assert.equal(search.items[0].email, 'client-695'); assert.equal(search.page, 1); assert.equal(search.pageSize, 100);
  assert.equal(clientsPagination(clients, new URL('https://example/clients?q=absent')).filtered, 0);
});

function panel(inboundId, extra = {}) {
  return { name: 'test', panelDbId: 1, inboundId, addClientUrl: 'https://panel.example/secret/panel/api/clients/add', apiKey: 'test-key', proxy: 'direct', ...extra };
}
function runtimeFor(records, inbounds) {
  const calls = [];
  return { calls, async request(target) {
    calls.push(target.url);
    let obj;
    if (target.url.endsWith('/inbounds/options')) obj = inbounds.map(({ id }) => ({ id }));
    else if (target.url.endsWith('/inbounds/list')) obj = inbounds;
    else if (target.url.endsWith('/onlines')) obj = ['shared'];
    else if (target.url.endsWith('/clients/list')) obj = records;
    else throw new Error('Unexpected URL');
    return { body: JSON.stringify({ success: true, obj }) };
  } };
}

test('modern client API preserves intersections, attachment status and shared quota accounting', async () => {
  const records = [
    { email: 'shared', subId: 'shared-sub', enable: true, totalGB: 1000, inboundIds: [4, 6], traffic: { up: 10, down: 20, total: 1000 } },
    { email: 'only-one', subId: 'one-sub', enable: false, totalGB: 500, inboundIds: [4], traffic: { up: 2, down: 3, total: 500 } },
    { email: 'orphan', subId: 'orphan-sub', inboundIds: [] }
  ];
  const inbounds = [4, 6].map(id => ({ id, settings: { clients: records.filter(r => r.inboundIds.includes(id)) }, clientStats: records.filter(r => r.inboundIds.includes(id) && r.traffic).map(r => ({ ...r.traffic, subId: r.subId })) }));
  const runtime = runtimeFor(records, inbounds);
  const panels = [panel('4'), panel('6')];
  const options = { includeSubscriptionUsage: false };
  const legacy = await listCreatedPanelClients(runtime, panels, options);
  runtime.calls.length = 0;
  const modern = await listCreatedPanelClients(runtime, panels, { ...options, clientApi: true });
  assert.deepEqual(modern, legacy);
  assert.equal(modern.clients[0].usage.used, 30);
  assert.equal(modern.panels[0].totalClients, 2);
  assert.equal(runtime.calls.filter(url => url.endsWith('/clients/list')).length, 1);
  assert.equal(runtime.calls.filter(url => url.endsWith('/inbounds/list')).length, 0);
  await assert.rejects(listCreatedPanelClients(runtime, [panel('99')], { ...options, clientApi: true }), /missing/);
});

test('legacy API fallback is remembered while authentication errors do not trigger a fallback', async () => {
  const inbound = { id: 4, settings: { clients: [] }, clientStats: [] };
  const runtime = runtimeFor([], [inbound]);
  const original = runtime.request;
  let probes = 0;
  runtime.request = async target => {
    if (target.url.endsWith('/clients/list')) { probes++; const e = new Error('not found'); e.statusCode = 404; throw e; }
    return original(target);
  };
  const options = { includeSubscriptionUsage: false, clientApi: true };
  await listCreatedPanelClients(runtime, [panel('4')], options);
  await listCreatedPanelClients(runtime, [panel('4')], options);
  assert.equal(probes, 1);
  const denied = { async request() { const e = new Error('unauthorized'); e.statusCode = 401; throw e; } };
  await assert.rejects(listCreatedPanelClients(denied, [panel('4')], options), /unauthorized/);
});

test('cold clients page responds immediately, then searches and paginates the authenticated full snapshot', async () => {
  const { createServer } = await import('../src/server.js');
  const blocked = deferred();
  let clientReads = 0;
  const records = Array.from({ length: 120 }, (_, n) => ({ email: `client-${String(n).padStart(3, '0')}`, subId: `sub-${n}`, enable: true, inboundIds: [4], totalGB: 1000, traffic: { up: 1, down: 2, total: 1000 } }));
  const runtime = {
    async request(target) {
      if (target.url.endsWith('/clients/list')) {
        clientReads++;
        await blocked.promise;
        return { body: JSON.stringify({ success: true, obj: records }) };
      }
      return { body: JSON.stringify({ success: true, obj: target.url.endsWith('/options') ? [{ id: 4 }] : [] }) };
    },
    async close() {}
  };
  const config = { panels: [panel('4')], sources: [], worker: { concurrency: 5 }, https: { enabled: false }, admin: { username: 'test-admin', password: 'test-password' }, clients: { cacheTtlMs: 20000, maxStaleMs: 120000, pageSize: 50 } };
  const app = await createServer(config, { runtime });
  const port = await listen(app.server);
  const headers = { Authorization: `Basic ${Buffer.from('test-admin:test-password').toString('base64')}` };
  const read = query => requestResponseDirect(`http://127.0.0.1:${port}/clients${query}`, { headers, timeoutMs: 1000 });
  try {
    await assert.rejects(requestResponseDirect(`http://127.0.0.1:${port}/clients`), error => error.statusCode === 401);
    const cold = await read('');
    assert.match(cold.body, /data-clients-loading/);
    assert.equal(clientReads, 1);
    blocked.resolve(); await tick();
    const first = await read('');
    assert.equal((first.body.match(/class="client-row"/g) || []).length, 50);
    assert.match(first.body, /120 matched clients/);
    assert.doesNotMatch(first.body, /client-119/);
    const last = await read('?page=3');
    assert.equal((last.body.match(/class="client-row"/g) || []).length, 20);
    assert.match(last.body, /client-119/);
    const search = await read('?q=client-119');
    assert.equal((search.body.match(/class="client-row"/g) || []).length, 1);
    assert.equal(clientReads, 1);
    await read('?refresh=1');
    assert.equal(clientReads, 2);
  } finally { blocked.resolve(); await app.close(); }
});

test('client edits redirect to a patched list without waiting for a full refresh and never resubmit on reload', async () => {
  const { createServer } = await import('../src/server.js');
  const refresh = deferred();
  let mutations = 0;
  let failMutation = false;
  const records = ['a', 'b', 'c'].map(suffix => ({
    id: `uuid-${suffix}`, email: `changed-${suffix}`, subId: `sub-${suffix}`,
    enable: true, totalGB: 1000, inboundIds: [4], traffic: { up: 10, down: 20, total: 1000 },
    expiryTime: 0, limitIp: 0, tgId: 0, reset: 0, comment: '', security: 'auto',
    flow: '', password: '', auth: '', reverse: null, group: ''
  }));
  const runtime = {
    async request(target, options) {
      let obj;
      if (target.url.includes('/clients/update/')) {
        mutations++;
        if (failMutation) return { statusCode: 200, body: JSON.stringify({ success: false, msg: 'panel rejected update' }) };
        const update = JSON.parse(options.body);
        Object.assign(records.find(record => record.email === update.email), update);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }
      if (target.url.includes('/clients/get/')) {
        const email = decodeURIComponent(target.url.split('/clients/get/')[1]);
        const record = records.find(record => record.email === email);
        return { statusCode: 200, body: JSON.stringify({ success: true, obj: {
          client: record, inboundIds: record.inboundIds, usedTraffic: record.traffic.up + record.traffic.down
        } }) };
      }
      if (target.url.endsWith('/clients/list')) {
        if (mutations) await refresh.promise;
        obj = records;
      } else if (target.url.endsWith('/inbounds/list')) {
        obj = [{ id: 4, settings: { clients: records }, clientStats: records.map(record => ({ ...record.traffic, subId: record.subId })) }];
      } else obj = target.url.endsWith('/options') ? [{ id: 4 }] : [];
      return { statusCode: 200, body: JSON.stringify({ success: true, obj }) };
    },
    async close() {}
  };
  const app = await createServer({ panels: [panel('4')], sources: [], worker: { concurrency: 5 }, https: { enabled: false }, clients: { pageSize: 1 } }, { runtime });
  const port = await listen(app.server);
  const raw = (url, body) => new Promise((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:${port}${url}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {} }, response => {
      let text = ''; response.on('data', chunk => text += chunk);
      response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location, body: text }));
    });
    request.on('error', reject); request.end(body);
  });
  try {
    await raw('/clients?refresh=1');
    const recovered = await raw('/clients/edit?page=3&pageSize=1');
    assert.equal(recovered.status, 303);
    assert.equal(recovered.location, '/clients?page=3&pageSize=1');
    assert.equal(mutations, 0);
    const saved = await raw('/clients/edit', new URLSearchParams({ subId: 'sub-c', status: 'disable', returnTo: '/clients?q=changed&page=3&pageSize=1' }).toString());
    assert.equal(saved.status, 303);
    const destination = new URL(saved.location, 'http://localhost');
    assert.equal(destination.pathname, '/clients');
    assert.equal(destination.searchParams.get('q'), 'changed');
    assert.equal(destination.searchParams.get('page'), '3');
    assert.equal(destination.searchParams.get('pageSize'), '1');
    const loading = await raw(saved.location);
    assert.equal(loading.status, 200);
    assert.doesNotMatch(loading.body, /data-clients-loading/);
    assert.match(loading.body, /Updated sub-c/);
    assert.match(loading.body, /class="status inactive"/);
    refresh.resolve(); await tick();
    const completed = await raw(saved.location);
    assert.doesNotMatch(completed.body, /Updated sub-c/);
    assert.match(completed.body, /changed-c/);
    assert.match(completed.body, /class="status inactive"/);
    assert.doesNotMatch(completed.body, /data-clients-loading/);
    assert.match(completed.body, /name="returnTo" value="\/clients\?page=3&amp;pageSize=1&amp;q=changed"/);
    const reloaded = await raw(saved.location);
    assert.equal(reloaded.status, 200);
    assert.equal(mutations, 1);
    assert.doesNotMatch(reloaded.body, /Updated sub-c/);

    const invalid = await raw('/clients/edit', new URLSearchParams({ subId: 'sub-c', returnTo: 'https://attacker.example/' }).toString());
    assert.equal(invalid.status, 303);
    assert.ok(invalid.location.startsWith('/clients?notice='));
    const validation = await raw(invalid.location);
    assert.match(validation.body, /No edit fields were provided/);
    assert.equal(mutations, 1);

    failMutation = true;
    const failed = await raw('/clients/edit', 'subId=sub-c&status=enable');
    const failedPage = await raw(failed.location);
    assert.match(failedPage.body, /Some panel updates failed for sub-c/);
    assert.match(failedPage.body, /panel rejected update/);
    assert.doesNotMatch(failedPage.body, /Updated sub-c/);
  } finally { refresh.resolve(); await app.close(); }
});
