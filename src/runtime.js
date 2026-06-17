import {
  fetchResponseDirect,
  fetchResponseViaHttpProxy,
  requestResponseDirect,
  requestResponseViaHttpProxy
} from './http-client.js';
import { startXrayHttpProxy } from './xray.js';

export async function createSubscriptionFetcher(config, dependencies = {}) {
  const startProxy = dependencies.startXrayHttpProxy || startXrayHttpProxy;
  const fetchDirect = dependencies.fetchResponseDirect || fetchResponseDirect;
  const fetchViaProxy = dependencies.fetchResponseViaHttpProxy || fetchResponseViaHttpProxy;
  const requestDirect = dependencies.requestResponseDirect || requestResponseDirect;
  const requestViaProxy = dependencies.requestResponseViaHttpProxy || requestResponseViaHttpProxy;
  let xrayProxy = null;
  let xrayProxyPromise = null;

  async function ensureXrayProxy(target) {
    if (xrayProxy) return xrayProxy;
    if (xrayProxyPromise) return xrayProxyPromise;
    if (!config.xrayOutboundLink) {
      throw new Error(`${target.name} requires Xray, but XRAY_OUTBOUND_LINK is not configured`);
    }

    xrayProxyPromise = startProxy({
      vlessLink: config.xrayOutboundLink,
      xrayBin: config.xrayBin
    }).then(
      (proxy) => {
        xrayProxy = proxy;
        return proxy;
      },
      (error) => {
        xrayProxyPromise = null;
        throw error;
      }
    );

    return xrayProxyPromise;
  }

  return {
    async fetch(source) {
      if (source.proxy === 'xray') {
        const proxy = await ensureXrayProxy(source);

        return fetchViaProxy(source.url, {
          proxyPort: proxy.port,
          timeoutMs: config.requestTimeoutMs
        });
      }

      return fetchDirect(source.url, {
        timeoutMs: config.requestTimeoutMs
      });
    },

    async request(target, options) {
      if (target.proxy === 'xray') {
        const proxy = await ensureXrayProxy(target);

        return requestViaProxy(target.url, {
          ...options,
          proxyPort: proxy.port,
          timeoutMs: config.requestTimeoutMs
        });
      }

      return requestDirect(target.url, {
        ...options,
        timeoutMs: config.requestTimeoutMs
      });
    },

    async close() {
      const proxy = xrayProxy || (xrayProxyPromise ? await xrayProxyPromise.catch(() => null) : null);
      xrayProxy = null;
      xrayProxyPromise = null;
      await proxy?.stop();
    }
  };
}
