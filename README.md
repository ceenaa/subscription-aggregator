# Subscription Aggregator

Small Node.js service that fetches two V2Ray/Xray subscription URLs, merges their decoded links, and returns one base64 subscription.

The first upstream is fetched through the supplied VLESS/WS/TLS link by starting a temporary local Xray HTTP proxy. The second upstream is fetched directly.

## Requirements

- Node.js 18 or newer
- `xray` available in `PATH`, or set `XRAY_BIN` in `.env` to the local binary path

No npm dependencies are required.

## Run as a server

```sh
npm start
```

Endpoints:

- `http://127.0.0.1:3000/sub/YOUR_TOKEN` returns an info page in a browser and the aggregated base64 subscription to subscription clients
- `http://127.0.0.1:3000/sub/plain/YOUR_TOKEN` returns the decoded merged links
- `http://127.0.0.1:3000/health` returns a health check

Use `?format=base64` to force raw subscription output in a browser:

```text
http://127.0.0.1:3000/sub/YOUR_TOKEN?format=base64
```

## Print once from CLI

```sh
npm run print -- YOUR_TOKEN
npm run print:plain -- YOUR_TOKEN
```

## Configuration

Create a `.env` file in this project directory. The app loads it automatically before starting the server or CLI.

```sh
PORT=3000
REQUEST_TIMEOUT_MS=15000
XRAY_BIN=xray

FIRST_SUBSCRIPTION_BASE_URL=https://first-provider.example/sub
FIRST_SUBSCRIPTION_PROXY=xray
SECOND_SUBSCRIPTION_BASE_URL=https://second-provider.example/sub
SECOND_SUBSCRIPTION_PROXY=direct
XRAY_OUTBOUND_LINK='vless://YOUR_UUID@proxy-host.example:443?type=ws&encryption=none&path=%2F&host=proxy-host.example&security=tls&fp=chrome&alpn=h2%2Chttp%2F1.1&sni=proxy-host.example#proxy-name'
```

Shell environment variables override `.env` values. For example:

```sh
FIRST_SUBSCRIPTION_PROXY=direct npm run print:plain -- YOUR_TOKEN
```

If Xray is only inside this project and not installed globally, set:

```sh
XRAY_BIN=./Xray-macos-arm64-v8a/xray
```

## Notes

- The VLESS link is used as an Xray outbound. The app creates a local HTTP inbound only so Node can proxy the first subscription request through Xray.
- Only the first source uses Xray. The second source always uses a direct HTTPS request.
- For troubleshooting, run `FIRST_SUBSCRIPTION_PROXY=direct npm run print:plain -- YOUR_TOKEN` to verify the first subscription URL without Xray.
- Browser requests to `/sub/YOUR_TOKEN` show a local info page with a QR code, source usage, remaining quota, and merged links.
- Output is a normal V2Ray subscription format: base64 of newline-separated links.
