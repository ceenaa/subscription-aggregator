import { buildListInboundsRequest } from './quota-worker.js';

function unsupported(message) {
  const error = new Error(message);
  error.unsupported = true;
  return error;
}

// Read complete credentials and settings immediately before a write. Cached
// email hints only locate the record; they never supply mutation field values.
export async function fetchPanelEditRecords(runtime, panel, subId, inboundIds, emails = []) {
  const request = buildListInboundsRequest(panel);
  const root = request.url.replace(/\/inbounds\/list\/?$/, '');
  async function read(path) {
    const response = await runtime.request(
      { name: panel.name, proxy: panel.proxy, url: root + path },
      { method: 'GET', headers: request.headers }
    );
    let payload;
    try { payload = JSON.parse(response.body); } catch { throw unsupported('Single-client API did not return JSON'); }
    return payload;
  }

  async function get(email, hint = false) {
    let payload;
    try { payload = await read(`/clients/get/${encodeURIComponent(email)}`); }
    catch (error) {
      if (hint && error.statusCode === 404) return null;
      throw error;
    }
    if (payload?.success === false) {
      if (hint) return null;
      throw new Error(`${panel.name} client read failed: ${payload.msg || 'unknown error'}`);
    }
    const record = payload?.obj?.client;
    const attachments = payload?.obj?.inboundIds;
    const used = payload?.obj?.usedTraffic;
    const fullFields = ['email', 'subId', 'totalGB', 'enable', 'expiryTime', 'limitIp', 'tgId', 'reset', 'comment', 'security', 'flow', 'password', 'auth', 'reverse', 'group'];
    if (!record || fullFields.some(key => !Object.hasOwn(record, key)) ||
        !Array.isArray(attachments) || !Number.isFinite(used) || used < 0 ||
        typeof record.email !== 'string' || typeof record.subId !== 'string' ||
        !(typeof record.uuid === 'string' || typeof record.id === 'string')) {
      throw unsupported('Single-client API did not return a full client record');
    }
    if (record.email !== email || record.subId !== subId) {
      if (hint) return null;
      throw new Error(`${panel.name} client identity changed; reload and retry`);
    }
    let reverse = record.reverse;
    if (typeof reverse === 'string') {
      try { reverse = reverse ? JSON.parse(reverse) : null; }
      catch { throw unsupported('Single-client API returned invalid reverse settings'); }
    }
    const client = {
      ...record,
      id: record.uuid ?? record.id,
      reverse,
      created_at: record.created_at ?? record.createdAt,
      updated_at: record.updated_at ?? record.updatedAt
    };
    delete client.uuid;
    delete client.createdAt;
    delete client.updatedAt;
    return { client, inboundIds: attachments.map(String), stat: { subId, up: 0, down: used, total: client.totalGB } };
  }

  function covers(records) {
    return inboundIds.every(id => records.some(record => record?.inboundIds.includes(String(id))));
  }

  const hints = [...new Set(emails.filter(Boolean))];
  if (hints.length) {
    const records = await Promise.all(hints.map(email => get(email, true)));
    if (records.every(Boolean) && covers(records)) return records;
  }

  // Cold/changed snapshots use a filtered identity search instead of a full
  // panel download. Fetch the full record after finding the exact subId.
  const params = new URLSearchParams({ page: '1', pageSize: '200', search: subId });
  const payload = await read(`/clients/list/paged?${params}`);
  if (payload?.success === false) throw new Error(`${panel.name} client search failed: ${payload.msg || 'unknown error'}`);
  const page = payload?.obj;
  if (!Array.isArray(page?.items) || !Number.isFinite(page.filtered) || page.filtered > page.items.length) {
    throw unsupported('Filtered client lookup is not supported');
  }
  const matches = [...new Set(page.items.filter(record => record.subId === subId).map(record => record.email))];
  const records = await Promise.all(matches.map(email => get(email)));
  if (!covers(records)) throw new Error(`Client ${subId} is missing from ${panel.name}`);
  return records;
}
