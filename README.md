# Subscription Aggregator

Small Node.js service that fetches two V2Ray/Xray subscription URLs, merges their decoded links, and returns one base64 subscription.

The first upstream is fetched through the supplied VLESS/WS/TLS link by starting a temporary local Xray HTTP proxy. The second upstream is fetched directly.

## Requirements

- Node.js 18 or newer
- `xray` available in `PATH`, or set `XRAY_BIN` in `.env` to the local binary path

No npm dependencies are required.

## Quota Worker

Run the quota worker manually:

```sh
npm run worker:quota
```

Preview what it would disable without updating panels:

```sh
npm run worker:quota:dry-run
```

Limit parallel client updates with:

```sh
WORKER_CONCURRENCY=5
```

The worker loads the same panel config used by `/inbounds`, calls each panel's `inbounds/list` endpoint, finds each configured inbound ID, and matches clients by `subId`. If a client does not exist on every configured panel, it is skipped.

The worker only evaluates matched clients that are active on at least one panel. If the client is already disabled on every configured panel, it is skipped.

A matched client is disabled on every configured panel when any quota check is true:

- any panel total is nonzero and `allTime >= total`
- all panel totals are nonzero and normalized combined usage is at or over the highest quota

For the combined check, the worker scales lower-quota panels up into the highest-quota panel's units:

```text
scale = higherTotal / panelTotal
normalizedUsed = sum(panelUsed * scale)
disable when normalizedUsed >= higherTotal
```

At the end, it logs the checked count, fully disabled clients, partially disabled clients, and skipped clients. A partial disable means at least one panel was updated but another active panel could not be updated, so the next run can retry the failed side. The update request preserves the client settings returned by 3x-ui and only changes `enable` to `false`.

To run it every minute with `crontab`, use absolute paths and a lock so overlapping runs do not stack up:

```cron
* * * * cd /Users/sina.moradi/Desktop/subscription/subscription-aggregator && if mkdir /tmp/subscription-aggregator-quota.lock 2>/dev/null; then /usr/bin/env PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin npm run worker:quota >> /tmp/subscription-aggregator-quota.log 2>&1; rmdir /tmp/subscription-aggregator-quota.lock; fi
```

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
HOST=127.0.0.1
REQUEST_TIMEOUT_MS=15000
XRAY_BIN=xray

FIRST_SUBSCRIPTION_BASE_URL=https://first-provider.example/sub
FIRST_SUBSCRIPTION_PROXY=xray
SECOND_SUBSCRIPTION_BASE_URL=https://second-provider.example/sub
SECOND_SUBSCRIPTION_PROXY=direct
XRAY_OUTBOUND_LINK='vless://YOUR_UUID@proxy-host.example:443?type=ws&encryption=none&path=%2F&host=proxy-host.example&security=tls&fp=chrome&alpn=h2%2Chttp%2F1.1&sni=proxy-host.example#proxy-name'

HTTPS_ENABLED=false
HTTPS_KEY_PATH=
HTTPS_CERT_PATH=
HTTPS_CA_PATH=
HTTPS_HSTS_ENABLED=false
HTTPS_HSTS_MAX_AGE=15552000

PUBLIC_BASE_URL=
TRUST_PROXY=false
CORS_ORIGIN=
WORKER_CONCURRENCY=5

ADMIN_USERNAME=
ADMIN_PASSWORD=

FIRST_PANEL_NAME=first-panel
FIRST_PANEL_ADD_CLIENT_URL=https://first-panel.example/secret/panel/api/inbounds/addClient
FIRST_PANEL_COOKIE=
FIRST_PANEL_INBOUND_ID=1
FIRST_PANEL_PROXY=xray
FIRST_PANEL_TOTAL_GB_RATIO=1
FIRST_PANEL_QUOTA_DIVISOR=1

SECOND_PANEL_NAME=second-panel
SECOND_PANEL_ADD_CLIENT_URL=https://second-panel.example/secret/panel/api/inbounds/addClient
SECOND_PANEL_COOKIE=
SECOND_PANEL_INBOUND_ID=1
SECOND_PANEL_PROXY=direct
SECOND_PANEL_TOTAL_GB_RATIO=1
SECOND_PANEL_QUOTA_DIVISOR=1

THIRD_PANEL_NAME=third-panel
THIRD_PANEL_ADD_CLIENT_URL=https://third-panel.example/secret/panel/api/inbounds/addClient
THIRD_PANEL_COOKIE=
THIRD_PANEL_INBOUND_ID=1
THIRD_PANEL_PROXY=direct
THIRD_PANEL_TOTAL_GB_RATIO=1
THIRD_PANEL_QUOTA_DIVISOR=1
```

Shell environment variables override `.env` values. For example:

```sh
FIRST_SUBSCRIPTION_PROXY=direct npm run print:plain -- YOUR_TOKEN
```

If Xray is only inside this project and not installed globally, set:

```sh
XRAY_BIN=./Xray-macos-arm64-v8a/xray
```

## HTTPS And Production

For direct HTTPS from Node, provide a certificate and private key:

```sh
HOST=0.0.0.0
PORT=3443
HTTPS_ENABLED=true
HTTPS_KEY_PATH=/absolute/path/to/privkey.pem
HTTPS_CERT_PATH=/absolute/path/to/fullchain.pem
HTTPS_HSTS_ENABLED=true
PUBLIC_BASE_URL=https://subscriptions.example.com
```

For production behind Nginx, Caddy, Cloudflare Tunnel, or another TLS reverse proxy, keep Node on HTTP and set the public URL used for QR codes:

```sh
HOST=127.0.0.1
PORT=3000
HTTPS_ENABLED=false
PUBLIC_BASE_URL=https://subscriptions.example.com
TRUST_PROXY=true
```

Enable CORS only for origins that need browser access to the raw subscription response:

```sh
CORS_ORIGIN=https://app.example.com,https://admin.example.com
```

Use `CORS_ORIGIN=*` only for a fully public service. The server exposes the `Subscription-Userinfo` header for browser clients and handles `OPTIONS` preflight requests.

The server also sends baseline production headers: `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, and `Cross-Origin-Resource-Policy`. HSTS is sent when `HTTPS_HSTS_ENABLED=true`.

## Create 3x-ui Clients

Open the create-client page:

```text
https://your-domain.com/inbounds
```

The page creates the same client on every configured panel. `FIRST_PANEL_PROXY=xray` sends that panel's `addClient` request through the Xray outbound. `SECOND_PANEL_PROXY=direct` and `THIRD_PANEL_PROXY=direct` send those panel requests directly.

The form matches the 3x-ui add-client modal fields: Enabled, Email, ID, Subscription, Comment, Total Flow, Start After First Use, and Duration. The API payload still includes `tgId: ""` because 3x-ui expects that key even when Telegram ID is not shown in the modal.

If multiple configured panels use the same panel URL, the create-client request adds a numeric suffix to the email for that shared panel database. For example, `client@example.com` becomes `client@example.com-1` and `client@example.com-2` for two matching panel URLs. The subscription ID stays the same across panels.

`Total Flow` is the base quota from the form. Each panel divides it by its own ratio:

```sh
FIRST_PANEL_TOTAL_GB_RATIO=1
SECOND_PANEL_TOTAL_GB_RATIO=2
THIRD_PANEL_TOTAL_GB_RATIO=1
```

With those values, entering `5` in `Total Flow` sends `5 GiB` to the first panel, `2.5 GiB` to the second panel, and `5 GiB` to the third panel. `0` still means unlimited for every panel.

`*_PANEL_QUOTA_DIVISOR` applies the same quota normalization used by the subscription page to the quota worker. Use `2` when a panel reports a `20 GiB` quota for two returned configs but the effective limit should be `10 GiB`. Uploaded/downloaded usage stays raw; only total quota is divided.

After the panel requests finish, the page shows the aggregated subscription generated by this app:

```text
https://your-domain.com/sub/CLIENT_SUBSCRIPTION_ID
```

It also shows a QR code plus links for the info page, forced base64 output, and plain decoded output.

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` before exposing this page outside localhost. The page uses HTTP Basic Auth when both values are configured.

Panel cookies are sensitive. Keep them only in `.env`, which is ignored by git:

```sh
FIRST_PANEL_COOKIE='3x-ui=...; lang=en-US'
SECOND_PANEL_COOKIE='3x-ui=...; lang=en-US'
THIRD_PANEL_COOKIE='3x-ui=...; lang=en-US'
```

## Notes

- The VLESS link is used as an Xray outbound. The app creates a local HTTP inbound only so Node can proxy the first subscription request through Xray.
- Only the first source uses Xray. The second source always uses a direct HTTPS request.
- For troubleshooting, run `FIRST_SUBSCRIPTION_PROXY=direct npm run print:plain -- YOUR_TOKEN` to verify the first subscription URL without Xray.
- Browser requests to `/sub/YOUR_TOKEN` show a local info page with a QR code, source usage, remaining quota, and merged links.
- If one upstream panel returns multiple config links for the same subscription, the displayed total quota is divided by the link count, while uploaded/downloaded usage stays as reported by the upstream.
- Output is a normal V2Ray subscription format: base64 of newline-separated links.
