import { fetchResponseDirect, fetchResponseViaHttpProxy } from './http-client.js';
import { startXrayHttpProxy } from './xray.js';

export async function createSubscriptionFetcher(config) {
  const needsXray = config.sources.some((source) => source.proxy === 'xray');
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

    async close() {
      await xrayProxy?.stop();
    }
  };
}
