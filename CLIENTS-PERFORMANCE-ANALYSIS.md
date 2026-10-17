# Clients page performance analysis

Measured on 16 October 2026 against the live Iran server and its configured panels. Production application files `server.js`, `panel-clients.js`, and `http-client.js` have the same SHA-256 hashes as this checkout. The supplied 3x-ui OpenAPI document was also reviewed. No application code, panel records, service configuration, or routes were changed during this analysis.

## Conclusion

The main bottleneck is transferring a large, uncompressed AWS panel response over the Xray route before the aggregator sends any HTML. The page then sends a large, uncompressed HTML document containing every client's hidden forms and details.

The most useful first changes are upstream compression and a client-focused API, browser response compression, a shared server-side snapshot cache, and pagination with lazy details. Existing requests to distinct panels already run in parallel. Increasing worker concurrency will not materially speed up the default page.

## Live measurements

These are diagnostic samples, not percentile benchmarks. Network conditions varied. The alternate APIs were tested in an isolated process using the production outbound configuration; those samples include a separate Xray proxy instance. No latency target below is a measured deployed improvement.

| Measurement | Result |
| --- | --- |
| Public authenticated `/clients` | HTTP 200; first byte 43.081 s; complete 43.373 s |
| `/clients` requested inside the Iran server | HTTP 200; first byte 19.620 s; complete 19.674 s |
| Public DNS / TCP / TLS cumulative times | 0.012 / 0.055 / 0.121 s |
| Local `/health` | HTTP 200 in 0.016 s |
| Clients displayed | 696 |
| HTML bytes | 3,426,187 |
| HTML element count | Approximately 62,017, counted from start tags |
| Same HTML compressed offline with gzip level 6 | Approximately 97–100 KB; about 97% smaller |
| Full-page rendering in isolated diagnostic process | 1.352 s, one sample |

The browser request explicitly advertised `gzip, br`, but the server returned no `Content-Encoding`. Most of the public test's 43 seconds elapsed before the first byte. Browser compression alone will therefore improve transfer size without removing the principal server wait.

Configured enabled attachments were AWS inbound 4, reverse inbound 10, and AWS inbound 6. This produces two physical-panel list requests and two online requests, not three independent full AWS downloads.

| API, through the application's current HTTP client | Route | Body bytes, uncompressed | Time |
| --- | --- | ---: | ---: |
| Reverse `/inbounds/list` | Direct | 536,871 | 0.270 s |
| Reverse `/clients/onlines` | Direct | 263 | 0.115 s |
| AWS `/clients/onlines` | Xray | 754 | 0.667 s |
| AWS `/inbounds/list` | Xray | 851,712 | 57.027 s |
| AWS `/clients/list/paged?page=1&pageSize=25` | Xray | 16,822 | 0.663 s |
| AWS `/clients/list` | Xray | 600,361 | 27.262 s |
| AWS `/inbounds/list/slim` | Xray | 422,819 | 10.953 s |
| Reverse `/clients/list/paged?page=1&pageSize=25` | Direct | 7,906 | 0.159 s |
| Reverse `/clients/list` | Direct | 700,527 | 0.670 s |
| Reverse `/inbounds/list/slim` | Direct | 235,226 | 0.436 s |

The isolated full client-list operation completed in 57.233 seconds, closely tracking its slowest upstream request. JSON parsing of the AWS full inbound response took only 27 ms. The full client API reported 707 AWS records and 1,072 reverse records; those are panel totals, not the aggregator's cross-panel intersection.

A separate sequential curl comparison through the same outbound configuration isolated transfer behavior:

| AWS request | Encoding actually returned | Wire bytes | First byte | Complete |
| --- | --- | ---: | ---: | ---: |
| `/inbounds/list` | gzip | 213,398 | 1.027 s | 6.539 s |
| `/inbounds/list` | identity | 851,712 | 0.863 s | 34.891 s |
| `/clients/list` | gzip | 85,741 | 0.628 s | 2.880 s |
| `/clients/list/paged?page=1&pageSize=200` | gzip | 17,298 | 0.996 s | 1.103 s |

The paired inbound tests reduced bytes by about 75% and elapsed time by about 81%. Payload throughput was roughly 24–33 KB/s in these samples. Fast response headers followed by a long body transfer support a bandwidth/route bottleneck, rather than a 35-second remote database query. These samples do not identify whether the underlying constraint comes from the route, congestion, filtering, or an upstream rate limit.

## What the code currently does

1. `src/server.js:575` waits for `loadClientsView` before calling `sendHtml`.
2. `src/panel-clients.js:208` deduplicates inbound-list requests within one page load. Different panels start concurrently.
3. `src/panel-clients.js:418` waits for both full panel lists and online-count requests. A slow or failed required panel delays or fails the entire result.
4. Clients are matched by `subId`, requiring membership in every configured enabled inbound. Same-panel traffic is counted once.
5. Normal `/clients` uses panel traffic. It does **not** fetch every client's subscription. `/clients?usage=subscription` explicitly enables that much more expensive behavior; expanding a client's details can fetch usage for that client.
6. `src/clients-page.js:230` renders an edit form and a details table for every client, including closed details and hidden forms.
7. `src/server.js:68` sends plain HTML without compression. Every refresh recomputes the list; the default no-store browser policy does not provide a server snapshot cache.

## Recommended implementation order

### 1. Compress upstream responses and use a smaller client API

`src/http-client.js:6` explicitly sets `Accept-Encoding: identity`. Both live panels support gzip. Add gzip negotiation and correct response decompression to direct and proxied requests.

Changing the request header alone is insufficient: the existing client converts response bytes directly to UTF-8. It would try to parse compressed data as JSON. Decode `Content-Encoding` before converting to text, and preserve response framing, body limits, and timeout behavior. Prefer asynchronous or streaming decompression.

For the first API migration, compressed `/panel/api/clients/list` is a useful candidate: it returns one client record with `subId`, traffic, and `inboundIds`, instead of repeating client settings across inbounds and sending unrelated inbound transport configuration. It returned all AWS records in 2.880 seconds in the transfer test. The direct panel's full client API was slightly larger than its inbound API, so this is primarily an AWS-route win.

Filter attachments against the configured inbound IDs, build each panel's `subId` index, then apply the existing cross-panel intersection and quota normalization. Check parity before rollout: membership, active/partial/inactive status, per-panel totals, and shared traffic deduplication. Keep fresh full-record reads for edits because list projections must not overwrite secrets or omitted client fields. Capability detection and a legacy fallback should handle differing panel versions.

`/clients/list/paged` is also available on both panels and is the smallest tested response. Page size is capped at 200. It is suitable for maintaining a local snapshot or a more involved incremental design. Fetching all present records would require four AWS pages and six reverse pages before attachment filtering, unless the query narrows the set.

Two correctness constraints matter:

- Intersecting page 1 from each panel is wrong: different panels contain different extra clients, and the same client can fall on different pages. Build a complete joined snapshot before paginating it locally, or introduce an API that explicitly supports lookups/batches by the selected subscription IDs.
- `/inbounds/list/slim` is **not** a drop-in replacement. The supplied API removes `subId` from `settings.clients` and omits its enrichment in traffic records. The current indexer requires those IDs and would silently lose clients if switched without an adapter or additional identity mapping.

The bundled 3x-ui implementation's `ListPaged` calls the full `List()` before filtering and slicing. That implementation reduces wire payload, but it does not perform SQL-level pagination. The live API tests establish endpoint availability and payload size; they do not establish that the live panels run this exact bundled implementation.

### 2. Compress HTML and reduce the browser's initial work

Add negotiated gzip, optionally Brotli, to HTML and appropriate JSON/JS responses. Use `Vary: Accept-Encoding`, preserve existing `Vary` values, handle HEAD correctly, and retain private/no-store behavior for authenticated data. Use streaming/asynchronous compression or a reverse proxy rather than synchronous compression in the request handler.

The existing 3.43 MB page compressed to approximately 100 KB without changing its content. This is a measured size reduction, not a claim that compression alone fixes first-byte time.

Paginate the **joined local result** into 25–50 rows. Render one reusable edit dialog on demand and load expanded details only when requested. Keep search over the complete snapshot so filtering does not become limited to the current page. This reduces the current 62,000-element DOM, thousands of listeners, and server rendering work.

### 3. Share a fresh snapshot across page loads

Keep panel read snapshots in the server process with a starting freshness interval of 15–30 seconds. Coalesce concurrent refreshes so multiple browser requests share one in-flight upstream fetch. Cache identity must include the API endpoint, credentials, route, and relevant configuration; invalidate on panel/settings changes and successful client mutations.

Serve a recent snapshot immediately and refresh it in the background. Display the last successful update time and per-panel refresh errors. For an outage, a bounded stale display can preserve access to the last complete joined list; show its age explicitly and stop presenting it as current after a defined limit. Do not silently display a partial intersection as the complete client set.

Keep quota enforcement and mutation read-before-write operations on fresh data. A display cache must not become the quota worker's accounting source. Protect against an older refresh overwriting a newer post-edit result.

Keep the existing browser no-store policy: a server cache behind authentication can improve speed without making the authenticated page publicly cacheable. Move online counts out of the main list's critical path and use their own short timeout/cache.

An initial shell can be returned immediately and fetch snapshot data separately. This improves first paint even on a cold cache, but is useful only if its loading/error states are clear. The complete list still requires upstream data on the first cold load.

### 4. Reuse connections and replace the custom proxy parser

The upstream HTTP client explicitly sends `Connection: close`. The proxied path creates a new CONNECT tunnel and TLS session for each request and destroys it after completion (`src/http-client.js:350`). TLS setup was approximately 0.29–0.32 seconds per curl request in these samples. Reuse a small per-origin connection pool for direct requests and Xray HTTP-proxy requests.

Changing only the `Connection` header will not pool these custom proxy sockets. A maintained proxy-aware client, such as Undici's `ProxyAgent`, is a practical option; confirm Node 22/package compatibility and preserve authentication, routing, redirects, deadlines, and shutdown cleanup. See the [official ProxyAgent documentation](https://github.com/nodejs/undici/blob/main/docs/docs/api/ProxyAgent.md).

The chunked-body reader also concatenates and reparses all received chunks on every data event (`src/http-client.js:187`). That creates repeated copying and parsing as bodies grow. Replace it with an incremental parser or the maintained client's HTTP parser. This is a code-level scalability issue, but no CPU profile in this analysis attributes the observed 35-second wait to it.

Use bounded concurrency, initially perhaps two requests per remote origin, when paged reads are needed. Tune from measurements. Avoid launching hundreds of client-specific requests across a constrained route.

The configured request timeout is 60 seconds. The custom proxy path has separate connection, CONNECT-header, and TLS/body timers, so this is not one end-to-end budget covering the entire operation. Introduce a single overall deadline and cancellation across those stages. With a snapshot available, a failed refresh can return a clear stale/error state rather than holding the browser open through multiple timeout stages. Shorten budgets only after reducing payloads; today's uncompressed list genuinely needs tens of seconds.

### 5. Fix the health check and measure route quality separately

The deployed failover timer runs every three minutes. Its health check downloads `/clients?format=html` with a 30-second limit. Recent logs show repeated timeouts and unsuccessful backup-route probes. The current route was left unchanged in the inspected events; the application reported zero automatic service restarts during its current service lifetime.

Split health checks into:

- App liveness via `/health`, measured at 16 ms locally.
- Upstream authenticated reachability via a small request, for example `/clients/list/paged?page=1&pageSize=1`, validating success and response shape.
- Periodic transfer-quality measurements, separately from reachability.

Liveness alone cannot establish that AWS works. Conversely, a successful 404 or unauthenticated transport probe cannot establish authenticated API health. Choose failover using repeated real failures and useful latency/throughput measurements, rather than the cost of rendering the entire dashboard.

Benchmark candidate Xray routes using the same authenticated compressed API request before changing routing. The measured payload rate warrants route investigation, but compression and caching offer clear gains even if the route cannot be improved.

## Parallelism, hardware, and changes with limited value

- The two physical-panel list calls and online reads already overlap. Adding another `Promise.all` around them cannot remove the AWS transfer bottleneck.
- `WORKER_CONCURRENCY` controls per-client processing/subscription fan-out; it is not a remedy for the ordinary page's one large remote list download.
- Worker threads, a language rewrite, and database index changes are lower priorities given fast remote response headers and small JSON parsing times.
- HTTP/2 might reduce connection overhead if supported through the chosen client/proxy, but it is secondary to payload reduction, pooling, and caching. Browser-to-server TLS took only about 0.12 seconds cumulatively in the public test.
- The VPS has two CPUs and about 2 GB RAM. At sampling time about 939 MB was available, disk use was 37%, and there was no swap. CPU idle was 57–89% in a short sample, although hypervisor steal time reached 17%. This does not establish sustained saturation; there is no evidence here that a hardware upgrade is the first fix.
- Keep expensive per-client subscription usage lazy. Enabling subscription mode for the whole list would introduce roughly clients × sources upstream reads and undo the main optimization.

## Delivery plan and acceptance checks

1. Implement upstream gzip/decompression and browser compression; compare payloads and timings with the same configured route.
2. Introduce the client API adapter with a legacy fallback and validate membership/status/quota parity against the existing path.
3. Add shared snapshots, refresh coalescing, invalidation, explicit stale/error states, and independent online refresh.
4. Paginate the joined list and make edit/detail UI lazy. Replace proxy connection handling with a pooled client as a separate transport change.
5. Update the failover probe and collect at least 20 sequential page samples across several refresh cycles.

Suggested targets, pending implementation and measurement: a warm cached first page usable within one second on a normal connection, initial HTML compressed below 50 KB after pagination, and a cold full refresh in the low single-digit seconds on a healthy route. The 2.880-second compressed full AWS client response makes the cold target plausible, but it is not an end-to-end guarantee.

Record server-side timings for each panel's headers/body, decoding, joining, rendering, cache age, and refresh status. Measure browser first paint, usable table time, DOM size, and errors separately. Report p50/p95, not only the fastest sample. Validate unavailable panels, concurrent refreshes, edits during refresh, settings changes, legacy APIs, gzip/identity responses, and cross-panel clients with different page positions. Keep credentials and subscription contents out of performance logs.

## Implemented and deployed

The optimization was subsequently authorized and deployed on 16 October 2026. The implementation uses compressed `/clients/list` plus `/inbounds/options`, pooled native HTTP/HTTPS connections (including CONNECT), one request deadline, a shared 20-second snapshot with refresh coalescing and bounded stale display, immediate cold-start loading, and 50-row pagination with search across the full joined set. Browser responses use negotiated streaming gzip. The failover monitor now validates a small authenticated API request separately from app liveness.

Live parity verification compared the old and new loaders against the same panels: all 696 clients, statuses, quota totals, and usage values matched exactly. The release suite contains 75 passing tests, including direct/proxy compression and connection reuse, TLS validation, hard deadlines, cache invalidation races, legacy fallback, authentication, cold starts, and full-snapshot search/pagination.

Staging measured 20 warm requests at 25–90 ms each, transferring about 14 KB; the initial loading shell took 0.263 seconds. The first populated page contains 50 rows and about 4,527 elements, compared with 696 rows and 62,017 elements previously. A public production request after deployment completed in 0.383 seconds and transferred 14,242 bytes, versus the original 43.373 seconds and 3,426,187 bytes. This is about a 113× improvement for the measured warm request and a 99.6% wire-size reduction.

Explicit fresh reads remain network-dependent: the deployment verification's fresh snapshot took 12.905 seconds, and a staging fresh read took 18.499 seconds. Normal page navigation uses the shared snapshot, so that upstream delay is handled in the background. After a restart or cache expiry, the loading shell appears immediately while the first complete snapshot is fetched. Snapshot timestamps and refresh failures remain visible rather than presenting cached data as a new live measurement.

### Faster edits

The edit path now uses a fresh `/clients/get/:email` on each physical panel, with parallel reads and the existing Xray-first write ordering. Cached identities locate the records; quotas, credentials, and other mutation fields come from the fresh full response. It verifies `subId` and inbound membership, converts the database record ID/UUID and timestamp fields to the write format, and retains a legacy fallback.

Live read-only validation against a client shared by the configured panels completed both fresh reads and write-payload preparation in 194 ms: reverse returned 545 bytes in 17 ms, and AWS returned 676 bytes in 173 ms. Every write was intercepted locally during that check; no live client was modified, and credentials, protocol settings, and untouched fields were verified against the fresh records. These measurements cover read/preparation time, not remote mutation execution.

After a successful save, the confirmed status/quota changes are merged into the displayed row and summary counters. The list remains available while the complete snapshot refreshes in the background. Failed/skipped panel updates are not represented as successful. Generation checks prevent an older in-flight refresh from erasing the patch, and the original full-snapshot timestamp is retained. The release suite now contains 84 passing tests.

### Protocol field conversion correction

A subsequent live edit exposed a read/write schema mismatch: `ClientRecord.allowedIPs` is a database string, whereas `Client.allowedIPs` is an array of strings. The initial dry-run verified field preservation but missed this type distinction. The write adapter now decodes stored JSON arrays, handles empty optional forwarding data, validates all planned payloads before the first mutation, and stops retrying deterministic Go JSON decoding errors. Skipped panels display their actual reason. Regression fixtures now include the empty database strings returned by both live panels, and the suite contains 87 passing tests. Payload validation for the affected subscription checks the supplied Client schema with every live write intercepted.
