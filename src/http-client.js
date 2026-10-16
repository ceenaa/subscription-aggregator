import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const decoders = {
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
  br: promisify(brotliDecompress)
};
const directHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 });
const directHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 });
const proxyAgents = new Map();

export function parseChunkedBody(body) {
  const chunks = [];
  let offset = 0;

  while (true) {
    const nextLine = body.indexOf('\r\n', offset);
    if (nextLine === -1) return null;

    const sizeLine = body.subarray(offset, nextLine).toString('ascii');
    const sizeToken = sizeLine.split(';', 1)[0].trim();
    if (!/^[0-9a-f]+$/i.test(sizeToken)) {
      throw new Error(`Invalid HTTP chunk size: ${sizeLine}`);
    }

    const chunkSize = Number.parseInt(sizeToken, 16);
    if (!Number.isSafeInteger(chunkSize)) {
      throw new Error(`HTTP chunk size is too large: ${sizeLine}`);
    }

    if (chunkSize === 0) {
      const trailersStart = nextLine + 2;
      if (body.length < trailersStart + 2) return null;
      if (body.subarray(trailersStart, trailersStart + 2).equals(Buffer.from('\r\n'))) {
        return { complete: true, body: Buffer.concat(chunks) };
      }

      const trailersEnd = body.indexOf('\r\n\r\n', trailersStart);
      if (trailersEnd === -1) return null;

      return { complete: true, body: Buffer.concat(chunks) };
    }

    const chunkStart = nextLine + 2;
    const chunkEnd = chunkStart + chunkSize;
    if (body.length < chunkEnd + 2) return null;
    if (!body.subarray(chunkEnd, chunkEnd + 2).equals(Buffer.from('\r\n'))) {
      throw new Error('HTTP chunk did not end with CRLF');
    }

    chunks.push(body.subarray(chunkStart, chunkEnd));
    offset = chunkEnd + 2;
  }
}


function proxyAgent(proxyHost, proxyPort) {
  const key = `${proxyHost}:${proxyPort}`;
  if (proxyAgents.has(key)) return proxyAgents.get(key);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
  agent.createConnection = (options, callback) => {
    const socket = net.connect(proxyPort, proxyHost);
    const timeoutMs = options.timeout || 15000;
    let buffer = Buffer.alloc(0);
    let secureSocket;
    let settled = false;
    const deadline = setTimeout(() => finish(new Error(`Proxy connection timed out after ${timeoutMs}ms`)), timeoutMs);
    function finish(error, connection) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.off('data', onData);
      socket.off('error', onError);
      if (error) {
        secureSocket?.destroy();
        socket.destroy();
      }
      callback(error, connection);
    }
    function onError(error) { finish(error); }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 64 * 1024) return finish(new Error('Proxy CONNECT header is too large'));
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const status = /^HTTP\/1\.[01]\s+(\d+)/.exec(buffer.toString('latin1'));
      if (!status || Number(status[1]) !== 200) return finish(new Error(`Proxy CONNECT failed with HTTP ${status?.[1] || 'invalid response'}`));
      socket.off('data', onData);
      socket.off('error', onError);
      socket.pause();
      if (buffer.length > end + 4) socket.unshift(buffer.subarray(end + 4));
      secureSocket = tls.connect({ ...options, socket, servername: options.servername || options.host, ALPNProtocols: ['http/1.1'] });
      secureSocket.once('error', onError);
      secureSocket.once('secureConnect', () => {
        secureSocket.off('error', onError);
        finish(null, secureSocket);
      });
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('connect', () => {
      const destination = `${options.host}:${options.port || 443}`;
      socket.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\n`);
    });
  };
  proxyAgents.set(key, agent);
  return agent;
}

export function closeProxyConnections(proxyPort, proxyHost = '127.0.0.1') {
  const key = `${proxyHost}:${proxyPort}`;
  proxyAgents.get(key)?.destroy();
  proxyAgents.delete(key);
}

function requestOnce(url, options) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined || options.body === null ? null : Buffer.from(options.body);
    const headers = {
      'User-Agent': 'subscription-aggregator/1.0',
      Accept: '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      ...options.headers
    };
    if (body && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(body.length);
    }
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: options.method || 'GET', headers,
      agent: options.agent || (transport === https ? directHttpsAgent : directHttpAgent),
      signal: options.signal, timeout: options.timeoutMs,
      ...(options.ca ? { ca: options.ca } : {})
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          response.destroy(new Error('HTTP response exceeds the 64 MiB limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('HTTP response aborted')));
      response.once('end', () => resolve({
        statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks, size)
      }));
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function fetchResponse(urlString, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
  const deadline = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let currentUrl = new URL(urlString);
  let headers = { ...options.headers };
  try {
    for (let redirects = 0; redirects <= (options.maxRedirects ?? 3); redirects += 1) {
      if (!['http:', 'https:'].includes(currentUrl.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
      if (options.proxyPort && currentUrl.protocol !== 'https:') throw new Error('Proxy requests support HTTPS URLs only');
      const response = await requestOnce(currentUrl, {
        ...options, headers, signal: controller.signal,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
        agent: options.proxyPort ? proxyAgent(options.proxyHost || '127.0.0.1', options.proxyPort) : undefined
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        if (!response.headers.location) throw new Error(`HTTP ${response.statusCode} redirect did not include Location`);
        const nextUrl = new URL(response.headers.location, currentUrl);
        if (nextUrl.origin !== currentUrl.origin) {
          headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['authorization', 'cookie'].includes(key.toLowerCase())));
        }
        currentUrl = nextUrl;
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(`HTTP request failed with status ${response.statusCode}`);
        error.statusCode = response.statusCode;
        throw error;
      }
      let body = response.body;
      const encodings = String(response.headers['content-encoding'] || '').split(',').map(x => x.trim().toLowerCase()).filter(x => x && x !== 'identity');
      for (const encoding of encodings.reverse()) {
        if (!decoders[encoding]) throw new Error(`Unsupported HTTP content encoding: ${encoding}`);
        body = await decoders[encoding](body, { maxOutputLength: MAX_BODY_BYTES });
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      return { ...response, body: body.toString('utf8'), url: currentUrl.toString() };
    }
    throw new Error(`Too many redirects while fetching ${urlString}`);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason || error;
    throw error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
  }
}

export function fetchResponseDirect(url, options = {}) {
  return fetchResponse(url, { ...options, method: 'GET' });
}
export async function fetchTextDirect(url, options = {}) {
  return (await fetchResponseDirect(url, options)).body;
}
export function requestResponseDirect(url, options = {}) {
  return fetchResponse(url, { ...options, maxRedirects: options.maxRedirects ?? 0 });
}
export function fetchResponseViaHttpProxy(url, options) {
  if (!options?.proxyPort) throw new Error('proxyPort is required');
  return fetchResponse(url, { ...options, method: 'GET' });
}
export async function fetchTextViaHttpProxy(url, options) {
  return (await fetchResponseViaHttpProxy(url, options)).body;
}
export function requestResponseViaHttpProxy(url, options) {
  if (!options?.proxyPort) throw new Error('proxyPort is required');
  return fetchResponse(url, { ...options, maxRedirects: options.maxRedirects ?? 0 });
}
