# API Contract — The Anti-Spin Read

The API and the SPA are served by the **same Worker** (see
`docs/adr/0001-worker-monolith.md`). All routes below are relative to the
deployed origin (e.g. `https://anti-spin-read.<subdomain>.workers.dev`).

- Base path: `/api/*`
- All responses are JSON (`application/json`), including errors.
- Every response carries security headers and (for allowlisted origins) CORS
  headers — see [Headers](#headers).
- Route summary:

| Route | Auth | Cache | Description |
|---|---|---:|---|
| `GET /api/health` | none | no-store (not set) | liveness |
| `POST /api/cron` | `x-cron-secret` | no-store | manual pipeline trigger |
| `GET /api/clusters` | none | **edge-cached 60s** | framed stories, paginated, newest first |
| `GET /api/search` | none | **edge-cached 60s** | search stories by key phrase / headline / lede |
| `GET /api/clusters/:id` | none | **edge-cached 60s** | single story (shareable deep links) |
| `GET /story/:id` | none | **edge-cached 3600s** | server-rendered OG share page for social/link previews |
| `GET /robots.txt` | none | `public, max-age=3600` | crawler rules (disallow `/api/`) |
| `GET /sitemap.xml` | none | **edge-cached 21600s** | story URLs for search engines (max 10 000) |
| `GET /*` (non-API) | none | SPA shell: `no-cache` (deploys change it); hashed assets served by ASSETS with Cloudflare default caching | the React SPA |

Any `/api/*` path that matches no route returns `404 {"error": "not found"}`.
Any unhandled error returns `500 {"error": "internal error"}` with an
`X-Request-Id` for correlation — never a stack trace.

---

## `GET /api/health`

Liveness probe for uptime monitors.

**Response `200`**

```json
{
  "ok": true,
  "time": "2026-08-15T12:00:00.000Z"
}
```

No auth, no caching headers set.

---

## `POST /api/cron`

Manually trigger one pipeline run (scrape → dedup → cluster → enrich → frame →
maintain → log). The automatic path is the Cron Trigger (`*/15 * * * *`).

### Auth — fail closed

| Condition | Result |
|---|---|
| `CRON_SECRET` not configured | **503** `{"error": "cron not configured"}` |
| Missing or wrong `x-cron-secret` header | **401** `{"error": "unauthorized"}` |
| Correct secret, under rate limit | **200** (below) |

- Comparison is **constant-time** (`secretsEqual` — manual XOR accumulation,
  length checked separately; lengths are not secret). There is **no default
  secret**: production must set one via `npx wrangler secret put CRON_SECRET`.
- Request header: `x-cron-secret: <secret>`.

### Rate limiting

Per-IP sliding window over **10 minutes**, default **5** triggers per IP,
configured with `CRON_RATE_LIMIT` (env var, positive integer; invalid values
fall back to 5). State is per-isolate in-memory — fine for a single Worker
instance; Cloudflare Rate Limiting rules are the upgrade path for
multi-isolate precision.

Every 200/429 response to this route carries:

- `X-RateLimit-Limit: <max per window>`
- `X-RateLimit-Remaining: <tokens left in window>` (0 when blocked)

When blocked, additionally:

- `Retry-After: <seconds until the window slides past the oldest hit>`
- **429** `{"error": "rate limited"}`

### Success `200`

```json
{
  "ok": true,
  "scraped": 120,
  "newArticles": 30,
  "clusters": 4,
  "framed": 3,
  "failed": 1
}
```

- `scraped` — articles collected from the RSS feeds (before dedup).
- `newArticles` — articles actually inserted (never seen before).
- `clusters` — cross-outlet clusters found this run.
- `framed` — clusters successfully framed by Gemini.
- `failed` — clusters whose framing failed (recorded; retried next run).
- `skipped` — present (`true`) when another run held the pipeline lock and
  this run skipped. When skipped, all counters are 0.

### Errors

| Status | Body | Meaning |
|---|---|---|
| 401 | `{"error": "unauthorized"}` | missing/wrong secret |
| 429 | `{"error": "rate limited"}` | per-IP limit exceeded |
| 500 | `{"error": "internal error"}` | pipeline threw |
| 503 | `{"error": "cron not configured"}` | `CRON_SECRET` unset (fail-closed) |

---

## `GET /api/clusters`

Framed stories, newest first. **Edge-cached** via the Workers Cache API keyed
on the full URL for **60 seconds** (`Cache-Control: public, max-age=60`) —
repeated page views and other-isolate hits are served from cache without
touching D1.

Ordering (D1 `ORDER BY`): clusters with a `framed_at` first (newest
`framed_at` first), then unframed clusters (newest `seen_at` first).

### Query parameters

| Param | Range | Default | Invalid → |
|---|---|---|---|
| `limit` | integer 1–50 | `50` | 400 |
| `offset` | integer 0–10000 | `0` | 400 |

Validation is **strict** (fail loudly, never silently clamp): non-integers,
`limit=0`, `limit=100`, negative offsets, etc. all return **400**
`{"error": "invalid limit/offset"}`.

### Response `200`

```json
{
  "limit": 50,
  "offset": 0,
  "hasMore": true,
  "clusters": [
    {
      "id": "42",
      "keyPhrase": "Bashar al-Assad sentenced to death in absentia",
      "category": "world",
      "seenAt": "2026-08-15T11:30:00.000Z",
      "framedAt": "2026-08-15T11:31:00.000Z",
      "framingError": null,
      "framing": {
        "headlineDeltas": [
          "CNN leads with the human toll in its headline; Reuters leads with the legal mechanics."
        ],
        "toneTags": [
          { "source": "CNN", "tone": "urgent" },
          { "source": "Reuters", "tone": "neutral" }
        ],
        "notableOmissions": [
          "The economic-impact angle appears in AP and the Guardian but is absent from CNN and Reuters coverage."
        ],
        "neutralSummary": "A court in Syria sentenced former president Bashar al-Assad to death in absentia, and outlets differed in which aspect of the ruling they emphasized."
      },
      "articles": [
        {
          "source": "BBC",
          "title": "Syrian court sentences Assad to death in absentia",
          "url": "https://www.bbc.com/news/articles/...",
          "lede": "A court in Damascus has sentenced...",
          "publishedAt": "2026-08-15T11:20:00.000Z",
          "imageUrl": "https://ichef.bbci.co.uk/news/..."
        }
      ]
    }
  ]
}
```

Field notes:

- `id` — cluster id (string).
- `keyPhrase` — shortest article title in the cluster (≤ 300 chars).
- `category` — deterministic keyword classification, one of
  `politics | world | business | tech | science-health | crime-justice | culture-sport | other`
  (no LLM call; computed per request from keyPhrase, titles, ledes, and the
  neutral summary).
- `seenAt` / `framedAt` — ISO-8601; `framedAt` is `null` until framing
  succeeds.
- `framingError` — **always** either `null` or the generic string
  `"Framing failed"`. Real Gemini error details stay in D1 for the operator;
  clients never see internals.
- `framing` — the validated framing report, or `null` while pending/failed.
  Shape is enforced by `normalizeFraming` on write **and** on read:
  - `headlineDeltas: string[]` (max 10)
  - `toneTags: { source: string; tone: string }[]` (max 15; `tone` ∈
    `neutral | urgent | alarmist | skeptical | celebratory | analytical`)
  - `notableOmissions: string[]` (max 10)
  - `neutralSummary: string` (always non-empty — empty is treated as corrupt)
- `articles` — cluster members from **2+ different outlets**.
  - `url` / `imageUrl` are defense-in-depth re-checked with `isSafeHttpUrl`
    at serve time; a URL that fails (non-http(s), private/reserved host, any
    SSRF vector) is replaced with `""` — never served.
- `hasMore` — `true` when another page exists (fetched with `limit+1`, so no
  count query). When `offset` exceeds the dataset, an empty `clusters` array
  with `hasMore: false` is returned (a valid page, not an error).

### Errors

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error": "invalid limit/offset"}` | out-of-range/non-numeric params |
| 500 | `{"error": "internal error"}` | D1 failure etc. |

---

## `GET /api/search`

Search stories by substring match over the cluster **key phrase**, article
**titles**, and article **ledes** (case-insensitive). Plain SQLite `LIKE`
over a small table — no FTS5, no migration, no cost. **Edge-cached 60s** like
`/api/clusters` (the query is part of the cache key).

### Query parameters

| Param | Range | Default | Invalid → |
|---|---|---|---|
| `q` | 2–100 chars (trimmed) | — | 400 |
| `limit` | integer 1–50 | `50` | 400 |

`LIKE` metacharacters (`%`, `_`, `\`) in `q` are **escaped** — user input can
never widen the match into a wildcard scan. Short (1-char) and empty queries
are rejected, not silently ignored.

### Response `200`

```json
{
  "query": "assad",
  "limit": 50,
  "hasMore": false,
  "clusters": [ /* same shape as GET /api/clusters, newest seenAt first */ ]
}
```

- `clusters` — full cluster objects (identical shape to `/api/clusters`,
  including the same SSRF re-checks and `framingError` sanitization).
- Ordering: `seenAt` descending (newest story first).

### Errors

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error": "invalid q (2-100 chars)"}` | `q` missing, too short, or too long |
| 400 | `{"error": "invalid limit"}` | `limit` not an integer in 1–50 |
| 500 | `{"error": "internal error"}` | D1 failure |

---

## `GET /api/clusters/:id`

Single story by numeric id — powers the shareable deep links
(`#/story/<id>` in the SPA). **Edge-cached 60s**.

### Response `200`

A single cluster object, same shape as one entry of `GET /api/clusters`.

### Errors

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error": "invalid id"}` | not a 1–10 digit integer |
| 404 | `{"error": "not found"}` | id doesn't exist (e.g. purged after the 14-day retention) — **not cached** |
| 500 | `{"error": "internal error"}` | D1 failure |

---

## `GET /story/:id` — server-rendered share page

Social/link-preview page for a story (`<title>`, OG, Twitter Card, JSON-LD
`NewsArticle`). Served by the Worker (not the SPA) so **crawlers and link
previewers get real markup without JavaScript**. **Edge-cached 3600s**
(`Cache-Control: public, max-age=3600`).

- `id` must be a 1–10 digit integer (else the page below returns).
- Renders the neutral summary (or first lede) as the description, the first
  article's image (SSRF-gated by `isSafeHttpUrl`) as `og:image`, and the
  coverage list as visible links.
- All feed-derived text is HTML-escaped; the JSON-LD blob escapes `<`/`>`
  so feed titles containing `</script>` cannot break out of the script tag.
- Missing/pruned ids return a **404 noindex page** ("story no longer
  available") so crawlers drop stale links — never a soft-200.

## `GET /robots.txt`

```
User-agent: *
Allow: /
Disallow: /api/
Sitemap: <origin>/sitemap.xml
```

`Cache-Control: public, max-age=3600`. The sitemap URL uses the request's own
origin (works on the deployed domain and in local dev).

## `GET /sitemap.xml`

`<urlset>` of up to 10 000 story URLs (`<loc><origin>/story/<id></loc>` +
`<lastmod>` = seen date), newest first. **Edge-cached 21600s** (6 hours).
`Content-Type: application/xml`. Escaping is identical to the story page —
feed text can never inject markup into the XML.

---

## Headers

### Security headers (every response)

Applied by the `applySecurityHeaders` middleware on all responses — API,
SPA, cached responses, 404s:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
X-Request-Id: <8-hex chars>
```

`X-Request-Id` is generated per request and echoed in structured JSON logs —
correlate client reports with server logs via this header.

### CORS

Enabled **only** for origins in the `ALLOWED_ORIGINS` allowlist
(comma-separated env var). When unset, defaults to local dev origins:
`http://localhost:5173, http://localhost:8787`. Production serves the SPA and
API same-origin, so CORS rarely applies there.

For an allowlisted `Origin` request, responses additionally carry:

```
Access-Control-Allow-Origin: <echoed origin>
Vary: Origin
Access-Control-Allow-Headers: x-cron-secret, content-type
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

Preflight (`OPTIONS *`) returns `204` with no body.

---

## Environment variables (contract-relevant)

| Var | Kind | Default | Used by |
|---|---|---|---|
| `CRON_SECRET` | secret | *none — fail closed* | `POST /api/cron` auth |
| `CRON_RATE_LIMIT` | var | `5` | `/api/cron` per-IP window (10 min) |
| `GEMINI_API_KEY` | secret | *none* | pipeline framing |
| `GEMINI_MODEL` | var | `gemini-3.5-flash` | primary framing model |
| `GEMINI_MODEL_FALLBACK` | var | `gemini-3.1-flash-lite` | fallback after primary retries exhausted |
| `CLUSTER_WINDOW_HOURS` | var | `48` | scrape/cluster window |
| `ALLOWED_ORIGINS` | var | dev origins | CORS allowlist |

Bindings: `DB` (D1), `ASSETS` (SPA). See `backend/wrangler.jsonc` and
`backend/src/config.ts`.