# ADR 0003 — Structured Gemini output (responseSchema + normalization gate)

- **Status:** Accepted
- **Date:** 2026-08-15 (hardening pass, shipped as 1.0.0)
- **Deciders:** backend + docs (single-team project)

## Context

The product depends on per-cluster **framing reports** produced by Gemini:
how the headlines differ across outlets, per-outlet tone tags, notable
omissions, and a neutral summary. Model output is famously unreliable in
shape — markdown fences, prose wrapping, invented tones, truncated JSON. The
report is persisted to D1 (`clusters.framing`, JSON) and served to clients
through `/api/clusters`, so a malformed report is not just a UX problem: it
can poison the store and surface as broken content indefinitely.

## Decision

Three layers, each with a distinct job:

1. **Constrained decoding at the API** — the Gemini `generateContent` request
   sends `responseMimeType: "application/json"` with a `responseSchema`
   (`FRAMING_SCHEMA` in `backend/src/framing.ts`): `headlineDeltas` (array of
   strings), `toneTags` (array of `{source, tone}` with `tone` as a strict
   enum of `neutral|urgent|alarmist|skeptical|celebratory|analytical`),
   `notableOmissions` (array of strings), `neutralSummary` (string) — all four
   required. This makes structurally-valid JSON the *default* model behavior
   rather than a hope.
2. **`normalizeFraming` gate at rest** (`backend/src/framing-schema.ts`) —
   belt-and-braces validation on top of constrained decoding. It trims,
   filters (non-string entries, unknown tones, over-cap arrays:
   `MAX_HEADLINE_DELTAS` 10, `MAX_TONE_TAGS` 15, `MAX_NOTABLE_OMISSIONS` 10),
   and **throws on silent degradation**: an empty `neutralSummary` or a report
   with neither deltas nor tone tags is a failure, not a success. The same
   gate runs:
   - **on write** — `frameCluster` refuses to return anything `normalizeFraming`
     rejects, so invalid output never reaches D1;
   - **on read** — `D1Db.latestClusters` re-validates stored JSON with
     `parseFraming`; a corrupt row is skipped, never served.
3. **Model fallback** — the primary model (`GEMINI_MODEL`, default
   `gemini-3.5-flash`) gets 3 attempts with backoff (500/1500 ms); transient
   failures (429, 5xx, network, parse/validation) retry, non-retryable 4xx
   fail fast. When the primary is exhausted, `GEMINI_MODEL_FALLBACK` (default
   `gemini-3.1-flash-lite`) gets 2 attempts before the cluster is marked failed
   (`framing_error` recorded, retried from the queue on the next pipeline
   run). Model-not-found 404s (deprecated/renamed models) switch to the
   fallback model instead of failing fast. See `frameCluster` in
   `backend/src/framing.ts`.

## Why

- **The shape is a contract.** The frontend types (`Framing` in
  `frontend/src/types.ts`), the D1 column, and the API response all mirror
  the same four fields. Schema-constrained output plus a validation gate
  keeps that contract honest on both sides of the model.
- **Two independent defenses.** `responseSchema` is a strong signal but is
  not a guarantee (model deprecation, proxy behavior, schema-ignoring
  responses); `normalizeFraming` is deterministic and runs in every path.
  "No silent degradation" is a project rule: an empty success is a failure.
- **Failures must be visible, not silent.** A rejected report marks the
  cluster `framing_error` (client sees a generic "Framing failed" label;
  details stay in D1 for the operator) and the cluster re-enters the retry
  queue — a bad response is *retried*, never white-washed.
- **Eval gates in CI** keep this honest over time:
  - `scripts/eval-framing.ts` — offline corpus of realistic Gemini outputs
    (clean, fenced, prose-wrapped, bad tones, overlong, garbage,
    empty-summary, non-object) replayed through the real pipeline; garbage
    must be rejected, good output must parse. Live mode (`--live` /
    `GEMINI_API_KEY` set) scores one real call (quality ≥ 4/6). Run in CI
    (framing-eval job).
  - `scripts/eval-cluster.ts` — bilingual (EN/AR/ZH) labeled corpus through
    the real clustering pipeline; gates precision ≥ 0.8, recall ≥ 0.7, plus a
    decoy check (no cross-story mixing). Run in CI (cluster-eval job).

## Consequences / tradeoffs

- **Schema lock-in with the model vendor.** `responseSchema` is
  Gemini-specific (`generativelanguage.googleapis.com/v1beta/models`); moving
  providers means re-encoding the schema, but `normalizeFraming` and the
  `IFraming` type are provider-agnostic.
- **Rejection is expensive.** A validation failure costs the attempts for
  that cluster; mitigated by concurrency cap (3) and the retry-queue design
  (framing is never permanently lost).
- **Caps are lossy by design.** Arrays are sliced to caps (10/15/10); the
  prompt asks for concise output and the caps bound token cost and UI size.
  This is a product tradeoff, not an accident — validated in the eval corpus
  (the "overlong" case must still parse and pass).

## Alternatives considered

- **Free-form JSON + repair heuristics:** repair code becomes a second model
  (fragile, untestable); rejected in favor of deterministic validation.
- **Output-only validation without `responseSchema`:** works but wastes
  attempts on shape errors that constrained decoding prevents; the two
  layers together give the retry budget its best odds.
- **No gate on read:** cheaper, but a corrupt D1 row would be served forever;
  the read gate is a few lines for a hard correctness win.