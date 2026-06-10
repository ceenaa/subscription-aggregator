import {
  fetchResponseDirect,
  fetchResponseViaHttpProxy,
  requestResponseDirect,
  requestResponseViaHttpProxy
} from './http-client.js';
import { startXrayHttpProxy } from './xray.js';

export async function createSubscriptionFetcher(config) {
  let xrayProxy = null;

  async function ensureXrayProxy(target) {
    if (xrayProxy) return xrayProxy;
    if (!config.xrayOutboundLink) {
      throw new Error(`${target.name} requires Xray, but XRAY_OUTBOUND_LINK is not configured`);
    }

    xrayProxy = await startXrayHttpProxy({
      vlessLink: config.xrayOutboundLink,
      xrayBin: config.xrayBin
    });
    return xrayProxy;
  }

  return {
    async fetch(source) {
      if (source.proxy === 'xray') {
        const proxy = await ensureXrayProxy(source);

        return fetchResponseViaHttpProxy(source.url, {
          proxyPort: proxy.port,
          timeoutMs: config.requestTimeoutMs
        });
      }

      return fetchResponseDirect(source.url, {
        timeoutMs: config.requestTimeoutMs
      });
    },

    async request(target, options) {
      if (target.proxy === 'xray') {
        const proxy = await ensureXrayProxy(target);

        return requestResponseViaHttpProxy(target.url, {
          ...options,
          proxyPort: proxy.port,
          timeoutMs: config.requestTimeoutMs
        });
      }

      return requestResponseDirect(target.url, {
        ...options,
        timeoutMs: config.requestTimeoutMs
      });
    },

    async close() {
      await xrayProxy?.stop();
    }
  };
}
