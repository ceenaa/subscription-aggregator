import { buildListInboundsRequest, fetchPanelInbounds } from './quota-worker.js';

const capabilities = new WeakMap();

function unsupported(message) {
  const error = new Error(message);
  error.unsupported = true;
  return error;
}

async function readApi(runtime, panel, request, path) {
  const url = request.url.replace(/\/inbounds\/list\/?$/, path);
  const response = await runtime.request(
    { name: panel.name, proxy: panel.proxy, url },
    { method: 'GET', headers: request.headers }
  );
  let payload;
  try { payload = JSON.parse(response.body); } catch { throw unsupported('Client API did not return JSON'); }
  if (payload?.success === false) throw new Error(`${panel.name} client API failed: ${payload.msg || 'unknown error'}`);
  if (!Array.isArray(payload?.obj)) throw unsupported('Client API did not return a list');
  return payload.obj;
}

// Display-only projection. Mutations and quota enforcement keep their fresh inbound reads.
export async function fetchPanelClientSnapshot(runtime, panel) {
  let known = capabilities.get(runtime);
  if (!known) capabilities.set(runtime, known = new Map());
  const request = buildListInboundsRequest(panel);
  const identity = `${request.url}\u0000${panel.apiKey}\u0000${panel.proxy}`;
  if (known.get(identity) !== 'legacy') {
    try {
      const [records, inbounds] = await Promise.all([
        readApi(runtime, panel, request, '/clients/list'),
        readApi(runtime, panel, request, '/inbounds/options')
      ]);
      if (records.some(record => !Array.isArray(record.inboundIds)) || inbounds.some(inbound => inbound.id === undefined)) {
        throw unsupported('Client API projection is not supported');
      }
      const byId = new Map(inbounds.map(inbound => [String(inbound.id), {
        id: inbound.id, settings: { clients: [] }, clientStats: []
      }]));
      for (const record of records) {
        if (!record.subId) continue;
        for (const id of record.inboundIds) {
          const inbound = byId.get(String(id));
          if (!inbound) continue;
          inbound.settings.clients.push(record);
          if (record.traffic) inbound.clientStats.push({ ...record.traffic, subId: record.subId });
        }
      }
      known.set(identity, 'clients');
      return [...byId.values()];
    } catch (error) {
      if (!error.unsupported && ![404, 405].includes(error.statusCode)) throw error;
      known.set(identity, 'legacy');
    }
  }
  return fetchPanelInbounds(runtime, panel);
}

