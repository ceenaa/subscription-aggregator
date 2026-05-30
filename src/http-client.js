import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const DEFAULT_HEADERS = {
  'User-Agent': 'subscription-aggregator/1.0',
  Accept: '*/*',
  'Accept-Encoding': 'identity',
  Connection: 'close'
};

function normalizeBody(body) {
  if (body === undefined || body === null) return null;
  return Buffer.isBuffer(body) ? body : Buffer.from(String(body));
}

function requestHeaders(url, options = {}) {
  const body = normalizeBody(options.body);
  const headers = {
    ...DEFAULT_HEADERS,
    ...options.headers
  };

  if (body && !headers['Content-Length'] && !headers['content-length']) {
    headers['Content-Length'] = String(body.length);
  }

  return {
    body,
    headers: {
      Host: hostHeader(url),
      ...headers
    }
  };
}

function requestPath(url) {
  return `${url.pathname || '/'}${url.search || ''}`;
}

function hostHeader(url) {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

function shouldRedirect(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function resolveRedirect(fromUrl, location) {
  if (!location) return null;
  return new URL(location, fromUrl).toString();
}

function decodeChunkedBody(body) {
  const chunks = [];
  let offset = 0;

  while (offset < body.length) {
    const nextLine = body.indexOf('\r\n', offset);
    if (nextLine === -1) break;

    const sizeLine = body.subarray(offset, nextLine).toString('ascii');
    const chunkSize = Number.parseInt(sizeLine.split(';')[0], 16);
    if (!Number.isFinite(chunkSize)) break;

    offset = nextLine + 2;
    if (chunkSize === 0) break;

    chunks.push(body.subarray(offset, offset + chunkSize));
    offset += chunkSize + 2;
  }

  return Buffer.concat(chunks);
}

function parseRawHttpResponse(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    throw new Error('HTTP response did not contain a complete header');
  }

  const headerText = buffer.subarray(0, headerEnd).toString('latin1');
  const [statusLine, ...headerLines] = headerText.split('\r\n');
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d+)/i.exec(statusLine);
  if (!statusMatch) {
    throw new Error(`Invalid HTTP status line: ${statusLine}`);
  }

  const headers = {};
  for (const line of headerLines) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }

  let body = buffer.subarray(headerEnd + 4);
  if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
    body = decodeChunkedBody(body);
  }

  return {
    statusCode: Number.parseInt(statusMatch[1], 10),
    headers,
    body
  };
}

function readAllFromSocket(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };

    const onData = (chunk) => {
      chunks.push(chunk);
      totalLength += chunk.length;
    };

    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, totalLength));
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    };

    socket.setTimeout(timeoutMs);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

function readHttpHeader(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };

    const onData = (chunk) => {
      chunks.push(chunk);
      totalLength += chunk.length;

      const buffer = Buffer.concat(chunks, totalLength);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      cleanup();
      const rest = buffer.subarray(headerEnd + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(buffer.subarray(0, headerEnd + 4));
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error(`Proxy CONNECT timed out after ${timeoutMs}ms`));
    };

    socket.setTimeout(timeoutMs);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

function openHttpTunnel({ proxyHost, proxyPort, targetHost, targetPort, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, proxyHost);

    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };

    const onConnect = async () => {
      cleanup();
      try {
        socket.write(
          [
            `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
            `Host: ${targetHost}:${targetPort}`,
            'Proxy-Connection: keep-alive',
            '',
            ''
          ].join('\r\n')
        );

        const header = await readHttpHeader(socket, timeoutMs);
        const { statusCode } = parseRawHttpResponse(header);
        if (statusCode < 200 || statusCode >= 300) {
          socket.destroy();
          reject(new Error(`Proxy CONNECT failed with HTTP ${statusCode}`));
          return;
        }

        resolve(socket);
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error(`Proxy connection timed out after ${timeoutMs}ms`));
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

function sendHttpsRequestOverSocket(socket, url, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket,
      servername: url.hostname,
      ALPNProtocols: ['http/1.1']
    });

    const cleanup = () => {
      tlsSocket.off('secureConnect', onSecureConnect);
      tlsSocket.off('error', onError);
    };

    const onSecureConnect = async () => {
      cleanup();
      try {
        const { body, headers } = requestHeaders(url, options);
        tlsSocket.write(
          [
            `${options.method || 'GET'} ${requestPath(url)} HTTP/1.1`,
            ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
            '',
            ''
          ].join('\r\n')
        );
        if (body) tlsSocket.write(body);

        const responseBuffer = await readAllFromSocket(tlsSocket, timeoutMs);
        resolve(parseRawHttpResponse(responseBuffer));
      } catch (error) {
        reject(error);
      }
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    tlsSocket.once('secureConnect', onSecureConnect);
    tlsSocket.once('error', onError);
  });
}

function requestDirect(url, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'http:' ? http : https;
    const { body, headers } = requestHeaders(url, options);
    const request = transport.request(
      url,
      {
        method: options.method || 'GET',
        headers,
        timeout: timeoutMs
      },
      (response) => {
        const chunks = [];
        let totalLength = 0;

        response.on('data', (chunk) => {
          chunks.push(chunk);
          totalLength += chunk.length;
        });

        response.once('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks, totalLength)
          });
        });
      }
    );

    request.once('timeout', () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function fetchWithRedirects(urlString, requestFn, timeoutMs, maxRedirects, options = {}) {
  let currentUrl = new URL(urlString);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await requestFn(currentUrl, timeoutMs, options);

    if (shouldRedirect(response.statusCode)) {
      const location = response.headers.location;
      const nextUrl = resolveRedirect(currentUrl, Array.isArray(location) ? location[0] : location);

      if (!nextUrl) {
        throw new Error(`HTTP ${response.statusCode} redirect did not include Location`);
      }

      currentUrl = new URL(nextUrl);
      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP request failed with status ${response.statusCode}`);
    }

    return {
      ...response,
      body: response.body.toString('utf8'),
      url: currentUrl.toString()
    };
  }

  throw new Error(`Too many redirects while fetching ${urlString}`);
}

export async function fetchTextDirect(url, options = {}) {
  const response = await fetchResponseDirect(url, options);
  return response.body;
}

export function fetchResponseDirect(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRedirects = options.maxRedirects ?? 3;
  return fetchWithRedirects(url, requestDirect, timeoutMs, maxRedirects, {
    method: 'GET'
  });
}

export async function fetchTextViaHttpProxy(url, options) {
  const response = await fetchResponseViaHttpProxy(url, options);
  return response.body;
}

export function fetchResponseViaHttpProxy(url, options) {
  if (!options?.proxyPort) {
    throw new Error('proxyPort is required');
  }

  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRedirects = options.maxRedirects ?? 3;
  const proxyHost = options.proxyHost ?? '127.0.0.1';
  const proxyPort = options.proxyPort;

  return fetchWithRedirects(
    url,
    async (currentUrl) => {
      if (currentUrl.protocol !== 'https:') {
        throw new Error('Proxy fetch currently supports HTTPS subscription URLs only');
      }

      const targetPort = currentUrl.port ? Number.parseInt(currentUrl.port, 10) : 443;
      const tunnel = await openHttpTunnel({
        proxyHost,
        proxyPort,
        targetHost: currentUrl.hostname,
        targetPort,
        timeoutMs
      });

      return sendHttpsRequestOverSocket(tunnel, currentUrl, timeoutMs, {
        method: 'GET'
      });
    },
    timeoutMs,
    maxRedirects
  );
}

export function requestResponseDirect(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRedirects = options.maxRedirects ?? 0;
  return fetchWithRedirects(url, requestDirect, timeoutMs, maxRedirects, options);
}

export function requestResponseViaHttpProxy(url, options) {
  if (!options?.proxyPort) {
    throw new Error('proxyPort is required');
  }

  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRedirects = options.maxRedirects ?? 0;
  const proxyHost = options.proxyHost ?? '127.0.0.1';
  const proxyPort = options.proxyPort;

  return fetchWithRedirects(
    url,
    async (currentUrl, requestTimeoutMs, requestOptions) => {
      if (currentUrl.protocol !== 'https:') {
        throw new Error('Proxy request currently supports HTTPS URLs only');
      }

      const targetPort = currentUrl.port ? Number.parseInt(currentUrl.port, 10) : 443;
      const tunnel = await openHttpTunnel({
        proxyHost,
        proxyPort,
        targetHost: currentUrl.hostname,
        targetPort,
        timeoutMs: requestTimeoutMs
      });

      return sendHttpsRequestOverSocket(tunnel, currentUrl, requestTimeoutMs, requestOptions);
    },
    timeoutMs,
    maxRedirects,
    options
  );
}
