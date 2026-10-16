import { createGzip } from 'node:zlib';
import { buildResponseHeaders } from './response-headers.js';

function acceptsGzip(value = '') {
  const qualities = new Map(String(value).toLowerCase().split(',').map(item => {
    const [encoding, ...parameters] = item.trim().split(';');
    const q = parameters.map(x => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(x)).find(Boolean);
    return [encoding, q ? Number(q[1]) : 1];
  }));
  return (qualities.get('gzip') ?? qualities.get('*') ?? 0) > 0;
}

export function sendCompressed(config, request, response, statusCode, body, contentType, extra = {}) {
  const headers = buildResponseHeaders(config, request, contentType, extra);
  headers.Vary = `${headers.Vary}, Accept-Encoding`;
  const compress = Buffer.byteLength(body) >= 1024 && acceptsGzip(request.headers['accept-encoding']);
  if (compress) headers['Content-Encoding'] = 'gzip';
  response.writeHead(statusCode, headers);
  if (request.method === 'HEAD') return response.end();
  if (!compress) return response.end(body);
  const gzip = createGzip({ level: 4 });
  gzip.once('error', error => response.destroy(error));
  response.once('close', () => gzip.destroy());
  gzip.pipe(response);
  gzip.end(body);
}
