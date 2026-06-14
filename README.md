# Subscription Aggregator

Small Node.js service that fetches configured V2Ray/Xray subscription URLs, merges their decoded links, and returns one base64 subscription.

Subscription sources can be routed directly or through the supplied Xray outbound. 3x-ui panels and inbounds are stored in SQLite so one install can manage any number of panels and any number of inbounds.

## Requirements

- Node.js 22.5 or newer
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

The worker loads the same panel/inbound config used by `/inbounds`, calls each panel's `inbounds/list` endpoint, finds each enabled configured inbound ID, and matches clients by `subId`. If a client does not exist on every enabled configured inbound, it is skipped.

The worker only evaluates matched clients that are active on at least one inbound. If the client is already disabled on every enabled configured inbound, it is skipped.

When subscription sources are configured, the worker uses the same normalized `Subscription-Userinfo` calculation as `/sub/:token`. If subscription usage cannot be loaded or complete usage headers are missing, that client is skipped instead of falling back to panel stats.

With subscription sources configured, a matched client is disabled on every enabled configured inbound when:

- normalized subscription usage is at or over normalized subscription quota

If no subscription sources are configured, the worker falls back to panel stats. In that fallback mode, a matched client is disabled when any quota check is true:

- any inbound total is nonzero and `allTime >= total`
- all inbound totals are nonzero and normalized combined usage is at or over the highest quota

For the panel-stat fallback combined check, the worker scales lower-quota panels up into the highest-quota panel's units:

```text
scale = higherTotal / inboundTotal
normalizedUsed = sum(panelUsed * scale)
disable when normalizedUsed >= higherTotal
```

At the end, it logs only summary metrics: runtime, discovered clients, processed clients, fully disabled clients, partially disabled clients, unchanged clients, skipped clients, panel disable operations, worker concurrency, and skipped-reason counts. The worker retries failed disable requests before reporting a partial disable, and each successful response is verified by reloading that panel inbound and confirming the client is no longer active. A partial disable means at least one panel was updated but another active panel still could not be updated, or the failed side cannot be updated because required client data is missing. The update request preserves the client settings returned by 3x-ui and only changes `enable` to `false`.

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
- `http://127.0.0.1:3000/settings` manages 3x-ui panels and inbounds
- `http://127.0.0.1:3000/inbounds` creates a client on every enabled configured inbound
- `http://127.0.0.1:3000/clients` lists and edits created clients
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

Create a `.env` file in this project directory. The app loads it automatically before starting the server, CLI, or quota worker. Runtime settings stay in `.env`; panel and inbound settings are stored in SQLite and managed at `/settings`.

```sh
PORT=3000
HOST=127.0.0.1
REQUEST_TIMEOUT_MS=15000
SQLITE_DB_PATH=./data/subscription-aggregator.sqlite3
XRAY_BIN=xray

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
```

Shell environment variables override `.env` values. For example:

```sh
FIRST_SUBSCRIPTION_PROXY=direct npm run print:plain -- YOUR_TOKEN
```

`REQUEST_TIMEOUT_MS` is applied as a hard deadline to panel and subscription HTTP requests, including direct and Xray-proxied requests.

`FIRST_SUBSCRIPTION_*`, `SECOND_SUBSCRIPTION_*`, and `THIRD_SUBSCRIPTION_*` are still accepted as fallback subscription sources for older installs. SQLite subscription sources are listed first, and env sources whose `baseUrl` and route are not already configured in SQLite are appended. New sources should be added on each inbound in `/settings`.

If an existing `.env` contains `FIRST_PANEL_*`, `SECOND_PANEL_*`, or `THIRD_PANEL_*`, the first startup creates the SQLite database and migrates those panel/inbound records once. After that, edit them in `/settings`.

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

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD`, then open the settings page first and add panels plus inbounds:

```text
https://your-domain.com/settings
```

`/settings` is blocked unless admin auth is configured and the request is authenticated, because it stores panel cookies.

Panel fields:

- `Name`
- `Add Client URL`, ending with `/api/inbounds/addClient`
- `Cookie`
- `API Route`, either `direct` or `xray`
- `Enabled`

Inbound fields:

- `Panel`
- `Inbound ID`
- optional `Name`
- optional `Subscription Base URL`, `Subscription Name`, and `Subscription Route`
- `Total GB Ratio`
- `Quota Divisor`
- `XTLS Vision Flow`, off by default
- `Enabled`

Open the create-client page:

```text
https://your-domain.com/inbounds
```

Open the created-clients page:

```text
https://your-domain.com/clients
```

The page creates the same client on every enabled configured inbound. A panel with `API Route=xray` sends panel API requests through the Xray outbound. A panel with `API Route=direct` sends panel API requests directly.

The form matches the 3x-ui add-client modal fields: Enabled, Email, ID, Subscription, Comment, Total Flow, Start After First Use, and Duration. The API payload still includes `tgId: ""` because 3x-ui expects that key even when Telegram ID is not shown in the modal.

When an inbound has `XTLS Vision Flow` enabled in `/settings`, client creation sends `flow: "xtls-rprx-vision"` for that inbound. Inbounds without the toggle keep `flow: ""`.

If multiple configured inbounds use the same panel URL, the create-client request adds a numeric suffix to the email for that shared panel database. For example, `client@example.com` becomes `client@example.com-1` and `client@example.com-2` for two matching panel URLs. The subscription ID stays the same across inbounds.

`Total Flow` is the base quota from the form. Each inbound divides it by its own ratio:

```text
first inbound ratio = 1
second inbound ratio = 2
third inbound ratio = 1
```

With those values, entering `5` in `Total Flow` sends `5 GiB` to the first inbound, `2.5 GiB` to the second inbound, and `5 GiB` to the third inbound. `0` still means unlimited for every inbound.

`Quota Divisor` applies the same quota normalization rule to panel-stat views and the quota worker's panel-stat fallback. Use `2` when a panel reports a `20 GiB` quota for two returned configs but the effective limit should be `10 GiB`. Uploaded/downloaded usage stays raw; only total quota is divided.

After the panel requests finish, the page shows the aggregated subscription generated by this app:

```text
https://your-domain.com/sub/CLIENT_SUBSCRIPTION_ID
```

It also shows a QR code plus links for the info page, forced base64 output, and plain decoded output.

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` before exposing create/client pages outside localhost. Those pages use HTTP Basic Auth when both values are configured.

The `/clients` page reads each configured panel's `inbounds/list` endpoint, shows only clients whose `subId` exists in every enabled configured inbound, supports live filtering by email or subscription ID, and shows the same subscription-header usage used by `/sub/:token`. Use `/clients?usage=panel` only when you need the faster panel-stat view; opening a client's details in that mode still loads the authoritative subscription usage for that client. Its edit form can enable or disable the client, add base traffic using each inbound's `Total GB Ratio`, set an expiry date, or clear expiry while preserving all other client fields.

Panel mutations run Xray-routed panels before direct panels. Each Xray mutation gets the initial attempt plus three retries; if an Xray mutation still fails, later panel mutations are skipped so direct panels are not updated alone.

Panel cookies are sensitive. They are stored in the SQLite database, which is ignored by git through `*.sqlite3`:

```text
./data/subscription-aggregator.sqlite3
```

## Notes

- The VLESS link is used as an Xray outbound. The app creates a local HTTP inbound only so Node can proxy Xray-routed subscription and panel requests.
- Each subscription source chooses its own route. Set an inbound subscription route to `direct` in `/settings` to verify that source without Xray.
- Browser requests to `/sub/YOUR_TOKEN` show a local info page with a QR code, source usage, remaining quota, and merged links.
- If one upstream panel returns multiple config links for the same subscription, the displayed total quota is divided by the link count, while uploaded/downloaded usage stays as reported by the upstream.
- Output is a normal V2Ray subscription format: base64 of newline-separated links.
