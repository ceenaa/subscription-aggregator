import {
  fetchResponseDirect,
  fetchResponseViaHttpProxy,
  requestResponseDirect,
  requestResponseViaHttpProxy
} from './http-client.js';
import { startXrayHttpProxy } from './xray.js';

export async function createSubscriptionFetcher(config) {
  const needsXray = [...config.sources, ...(config.panels || [])].some(
    (target) => target.proxy === 'xray'
  );
  const xrayProxy = needsXray
    ? await startXrayHttpProxy({
        vlessLink: config.xrayOutboundLink,
        xrayBin: config.xrayBin
      })
    : null;

  return {
    async fetch(source) {
      if (source.proxy === 'xray') {
        if (!xrayProxy) {
          throw new Error(`Source ${source.name} requires Xray, but Xray is not running`);
        }

        return fetchResponseViaHttpProxy(source.url, {
          proxyPort: xrayProxy.port,
          timeoutMs: config.requestTimeoutMs
        });
      }

      return fetchResponseDirect(source.url, {
        timeoutMs: config.requestTimeoutMs
      });
    },

    async request(target, options) {
      if (target.proxy === 'xray') {
        if (!xrayProxy) {
          throw new Error(`Target ${target.name} requires Xray, but Xray is not running`);
        }

        return requestResponseViaHttpProxy(target.url, {
          ...options,
          proxyPort: xrayProxy.port,
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
