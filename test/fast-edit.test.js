import assert from 'node:assert/strict';
import test from 'node:test';
import { updateCreatedPanelClient, listCreatedPanelClients, applyClientUpdateToSnapshot } from '../src/panel-clients.js';
import { createSnapshotCache } from '../src/snapshot-cache.js';
import { clientWriteFields } from '../src/client-write-fields.js';
import { renderClientsPage } from '../src/clients-page.js';

const gib = 1024 ** 3;
const panel = (name, id, inboundId, proxy = 'direct') => ({ name, panelName: name, panelDbId: id, inboundId, proxy, apiKey: 'test-key', addClientUrl: `https://${name}.example/panel/api/clients/add`, totalGbRatio: id, quotaDivisor: 1 });
const record = (email, uuid, totalGB = 10 * gib) => ({
  id: 123, uuid, email, subId: 'shared-sub', enable: true, totalGB,
  password: 'keep-password', auth: 'keep-auth', security: 'auto', flow: 'xtls-rprx-vision',
  reverse: { tag: 'keep-reverse' }, tgId: 17, group: 'keep-group', comment: 'keep-comment',
  expiryTime: 777, limitIp: 3, reset: 4, resetDay: 9, limitHwid: 2,
  privateKey: 'keep-private-key', publicKey: 'keep-public-key', allowedIPs: '', forwardedPorts: '',
  createdAt: 12345, updatedAt: 67890
});
const response = obj => ({ statusCode: 200, body: JSON.stringify({ success: true, obj }) });
const nextTick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ hints = true, failDirect = false, failXray = false } = {}) {
  const panels = [panel('aws', 1, '4', 'xray'), panel('reverse', 2, '10'), panel('aws', 1, '6', 'xray')];
  const clients = new Map([['aws', record('aws-email', 'aws-uuid')], ['reverse', record('reverse-email', 'reverse-uuid', 5 * gib)]]);
  const requests = [];
  const runtime = { async request(target, options) {
    const url = new URL(target.url);
    requests.push({ name: target.name, path: url.pathname, method: options.method, body: options.body });
    const client = clients.get(target.name);
    const inboundIds = target.name === 'aws' ? [4, 6] : [10];
    if (url.pathname.includes('/clients/get/')) return response({ client, inboundIds, usedTraffic: 300 });
    if (url.pathname.endsWith('/clients/list/paged')) return response({ items: [client], filtered: 1 });
    if (url.pathname.endsWith('/clients/list')) return response([{ ...client, inboundIds, traffic: { up: 100, down: 200, total: client.totalGB } }]);
    if (url.pathname.endsWith('/options')) return response(inboundIds.map(id => ({ id })));
    if (url.pathname.endsWith('/onlines')) return response([]);
    if (url.pathname.includes('/clients/update/')) {
      if ((failDirect && target.name === 'reverse') || (failXray && target.name === 'aws')) return { statusCode: 200, body: JSON.stringify({ success: false, msg: 'test failure' }) };
      return response(null);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  } };
  const targets = hints ? panels.map(p => ({ panelKey: `db:${p.panelDbId}`, inboundId: p.inboundId, email: clients.get(p.name).email })) : [];
  return { panels, clients, requests, runtime, targets };
}

test('fast edits fetch only complete target records, preserve credentials and protocol fields, and apply ratios once', async () => {
  const f = fixture();
  const result = await updateCreatedPanelClient(f.runtime, f.panels, { subId: 'shared-sub', addGB: '2', status: 'disable' }, { fastRead: true, targets: f.targets });
  assert.equal(result.ok, true);
  const reads = f.requests.filter(r => r.method === 'GET');
  assert.equal(reads.length, 2);
  assert.ok(reads.every(r => r.path.includes('/clients/get/')));
  const writes = f.requests.filter(r => r.method === 'POST');
  assert.deepEqual(writes.map(r => r.name), ['aws', 'reverse']);
  for (const [index, write] of writes.entries()) {
    const body = JSON.parse(write.body);
    const original = f.clients.get(write.name);
    assert.equal(body.id, original.uuid);
    assert.equal(typeof body.id, 'string');
    assert.equal(body.created_at, original.createdAt);
    assert.equal(body.updated_at, original.updatedAt);
    for (const key of ['password', 'auth', 'privateKey', 'publicKey', 'flow', 'security', 'reverse', 'tgId', 'group', 'comment', 'expiryTime', 'limitIp', 'reset', 'resetDay', 'limitHwid']) assert.deepEqual(body[key], original[key], key);
    assert.equal(body.totalGB, original.totalGB + (index ? gib : 2 * gib));
    assert.equal(body.enable, false);
    assert.equal(body.subId, undefined);
    assert.equal(body.uuid, undefined);
    assert.deepEqual(body.allowedIPs, []);
    assert.equal(body.forwardedPorts, undefined);
  }
  assert.equal(result.client.status, 'Inactive');
  assert.equal(result.client.usage.total, 12 * gib);
  assert.equal(result.client.panels[0].rawTotal, 12 * gib);
});

test('targeted reads on separate panels overlap before the existing Xray-first writes', { timeout: 1000 }, async () => {
  const f = fixture();
  const original = f.runtime.request;
  let release;
  const gate = new Promise(resolve => release = resolve);
  let reads = 0;
  f.runtime.request = async (target, options) => {
    if (target.url.includes('/clients/get/')) {
      if (++reads === 2) release();
      await gate;
    }
    return original(target, options);
  };
  await updateCreatedPanelClient(f.runtime, f.panels, { subId: 'shared-sub', status: 'disable' }, { fastRead: true, targets: f.targets });
  assert.equal(reads, 2);
});

test('cold edit lookup searches by exact subId and then reads full records', async () => {
  const f = fixture({ hints: false });
  await updateCreatedPanelClient(f.runtime, f.panels, { subId: 'shared-sub', clearExpiry: true }, { fastRead: true });
  assert.equal(f.requests.filter(r => r.path.endsWith('/list/paged')).length, 2);
  assert.equal(f.requests.filter(r => r.path.includes('/clients/get/')).length, 2);
  assert.equal(f.requests.filter(r => r.path.endsWith('/inbounds/list')).length, 0);
  for (const write of f.requests.filter(r => r.method === 'POST')) assert.equal(JSON.parse(write.body).expiryTime, 0);
});

test('partial write failures patch only confirmed fields and retain truthful panel summaries', async () => {
  const f = fixture({ failDirect: true });
  const snapshot = await listCreatedPanelClients(f.runtime, f.panels, { clientApi: true, includeSubscriptionUsage: false });
  const result = await updateCreatedPanelClient(f.runtime, f.panels, { subId: 'shared-sub', status: 'disable', addGB: '2' }, { fastRead: true, targets: f.targets });
  assert.equal(result.ok, false);
  assert.equal(result.client.status, 'Partial');
  assert.equal(result.client.panels[0].rawTotal, 12 * gib);
  assert.equal(result.client.panels[1].rawTotal, 5 * gib);
  const patched = applyClientUpdateToSnapshot(snapshot, result.client);
  assert.equal(patched.clients[0].status, 'Partial');
  assert.equal(patched.panels[0].activeClients, 0);
  assert.equal(patched.panels[0].inactiveClients, 1);
  assert.equal(patched.panels[1].activeClients, 1);
  assert.equal(snapshot.clients[0].status, 'Active');
});

test('an Xray write failure leaves direct panels untouched and does not invent a successful status', async () => {
  const f = fixture({ failXray: true });
  const result = await updateCreatedPanelClient(f.runtime, f.panels, { subId: 'shared-sub', status: 'disable' }, { fastRead: true, targets: f.targets });
  assert.equal(result.ok, false);
  assert.equal(result.client.status, 'Active');
  assert.equal(f.requests.filter(r => r.method === 'POST' && r.name === 'aws').length, 4);
  assert.equal(f.requests.filter(r => r.method === 'POST' && r.name === 'reverse').length, 0);
});

test('stale email hints cannot update a different subscription and missing exact matches perform no writes', async () => {
  const f = fixture();
  const original = f.runtime.request;
  f.runtime.request = async (target, options) => {
    if (target.url.includes('/clients/get/')) return response({ client: { ...f.clients.get(target.name), subId: 'different-sub' }, inboundIds: [4, 6, 10], usedTraffic: 0 });
    if (target.url.includes('/list/paged')) return response({ items: [{ email: 'other', subId: 'shared-sub-extra' }], filtered: 1 });
    return original(target, options);
  };
  await assert.rejects(updateCreatedPanelClient(f.runtime, f.panels, { subId: 'shared-sub', status: 'disable' }, { fastRead: true, targets: f.targets }), /missing/);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('legacy single-client APIs fall back to fresh inbounds while auth failures do not fall back', async () => {
  const f = fixture();
  const original = f.runtime.request;
  f.runtime.request = async (target, options) => {
    if (target.url.includes('/clients/get/') || target.url.includes('/list/paged')) throw Object.assign(new Error('not found'), { statusCode: 404 });
    if (target.url.endsWith('/inbounds/list')) {
      const client = f.clients.get(target.name);
      return response((target.name === 'aws' ? [4, 6] : [10]).map(id => ({ id, settings: { clients: [{ ...client, id: client.uuid }] }, clientStats: [] })));
    }
    return original(target, options);
  };
  assert.equal((await updateCreatedPanelClient(f.runtime, f.panels, { subId: 'shared-sub', status: 'disable' }, { fastRead: true, targets: f.targets })).ok, true);
  f.requests.length = 0;
  f.runtime.request = async () => { throw Object.assign(new Error('unauthorized'), { statusCode: 401 }); };
  await assert.rejects(updateCreatedPanelClient(f.runtime, f.panels, { subId: 'shared-sub', status: 'disable' }, { fastRead: true, targets: f.targets }), /unauthorized/);
  assert.equal(f.requests.length, 0);
});

test('patched snapshots stay available and an older refresh cannot erase a confirmed save', async () => {
  const loads = [];
  let time = 1000;
  const cache = createSnapshotCache({ now: () => time, load: () => new Promise(resolve => loads.push(resolve)) });
  const first = cache.get('config'); await nextTick(); loads[0]({ clients: ['before'] }); await first;
  const oldRefresh = cache.get('config', { force: true }); await nextTick();
  cache.invalidate({ keepValue: true });
  assert.deepEqual(cache.peek('config').clients, ['before']);
  assert.equal(cache.update('config', value => ({ ...value, clients: ['confirmed'] })), true);
  loads[1]({ clients: ['old read'] }); await oldRefresh;
  const visible = await cache.get('config', { wait: false });
  assert.equal(visible.loading, undefined);
  assert.equal(visible.stale, true);
  assert.equal(visible.updatedAt, 1000);
  assert.deepEqual(visible.data.clients, ['confirmed']);
  await nextTick(); loads[2]({ clients: ['refreshed'] }); await nextTick();
  assert.deepEqual(cache.peek('config').clients, ['refreshed']);
  assert.equal(cache.update('different-config', () => null), false);
  time += 120001;
  assert.equal(cache.peek('config'), undefined);
});


test('database JSON protocol fields become typed arrays without changing their values', () => {
  const input = {
    allowedIPs: '["10.0.0.2/32","::1/128"]',
    forwardedPorts: '[{"port":9000,"targetPort":9001}]',
    password: 'preserve-secret'
  };
  const normalized = clientWriteFields(input);
  assert.deepEqual(normalized.allowedIPs, ['10.0.0.2/32', '::1/128']);
  assert.deepEqual(normalized.forwardedPorts, [{ port: 9000, targetPort: 9001 }]);
  assert.equal(normalized.password, input.password);
  assert.equal(typeof input.allowedIPs, 'string');
  assert.deepEqual(clientWriteFields({ allowedIPs: '', forwardedPorts: '' }), { allowedIPs: [] });
  assert.deepEqual(clientWriteFields({ allowedIPs: null, forwardedPorts: null }), { allowedIPs: null, forwardedPorts: null });
  assert.deepEqual(clientWriteFields({ allowedIPs: ['10.0.0.2/32'], forwardedPorts: [9000] }), { allowedIPs: ['10.0.0.2/32'], forwardedPorts: [9000] });
  for (const allowedIPs of ['not json', '"a string"', '{}', '[123]']) {
    assert.throws(() => clientWriteFields({ allowedIPs }), error => error.retryable === false);
  }
});

test('malformed protocol fields on any panel reject the whole plan before the first mutation', async () => {
  const f = fixture();
  f.clients.get('reverse').allowedIPs = 'invalid stored IP JSON';
  await assert.rejects(updateCreatedPanelClient(f.runtime, f.panels, { subId: 'shared-sub', status: 'disable' }, { fastRead: true, targets: f.targets }), /allowedIPs must contain a JSON array/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
});

test('deterministic Go schema errors are not retried and skipped panels show the actual reason', async () => {
  const f = fixture();
  const original = f.runtime.request;
  let writes = 0;
  f.runtime.request = async (target, options) => {
    if (options.method === 'POST' && target.name === 'aws') {
      writes++;
      return { statusCode: 200, body: JSON.stringify({ success: false, msg: 'Something went wrong (json: cannot unmarshal string into Go struct field .allowedIPs of type []string)' }) };
    }
    return original(target, options);
  };
  const result = await updateCreatedPanelClient(f.runtime, f.panels, { subId: 'shared-sub', status: 'disable' }, { fastRead: true, targets: f.targets });
  assert.equal(writes, 1);
  assert.equal(result.ok, false);
  assert.equal(result.results[1].skipped, true);
  assert.match(result.results[1].error, /skipped after Xray failure/);
  assert.doesNotMatch(result.results[0].error, /after 4 attempts/);
  assert.equal(f.requests.filter(request => request.method === 'POST' && request.name === 'reverse').length, 0);
  const html = renderClientsPage({ message: 'Some panel updates failed', updateResults: result.results });
  assert.match(html, /skipped after Xray failure/);
  assert.doesNotMatch(html, /<span>No changes<\/span>/);
});
