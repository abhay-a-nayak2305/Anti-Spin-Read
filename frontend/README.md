# The Anti-Spin Read — Frontend

The Anti-Spin Read is a media-framing watchtower: it clusters the same story
across multiple news outlets and shows how each one framed it — headline
deltas, notable omissions, and tone — so readers can "read the difference."
This is the React frontend for that project.

## Stack

- **React 19** + **TypeScript** (strict, verbatim module syntax)
- **Vite 8** — dev server and production build
- **Tailwind CSS v4** — design tokens and custom classes in `src/index.css`
- **oxlint** — lint · **Vitest + Testing Library** — unit tests ·
  **Playwright** — browser UI test

## Getting started

```sh
npm install
npm run dev
```

The dev server runs on http://localhost:5173 and proxies `/api` to
`http://localhost:8787` (the Workers API via `wrangler dev`). To point the
frontend at a different API, set `VITE_API_BASE` before starting:

```sh
set VITE_API_BASE=http://localhost:4321
npm run dev
```

## Scripts

| Command           | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Start the Vite dev server (HMR, API proxy on :8787)       |
| `npm run build`   | Typecheck (`tsc -b`) then production build into `dist/`   |
| `npm run lint`    | Run oxlint                                                |
| `npm test`        | Run the Vitest unit tests (jsdom + Testing Library)       |
| `npm run preview` | Serve the production build locally                        |

## Seeded UI test

`tests/ui_test.py` is a Playwright (Python) end-to-end pass against the real
UI with seeded data. Start the seeded backend and the dev server, then run:

```sh
python .agents/skills/webapp-testing/scripts/with_server.py \
  --server "cd backend && npx tsx scripts/launch-seeded-ui.ts" --port 4321 \
  --server "cd frontend && set VITE_API_BASE=http://localhost:4321&& npm run dev" --port 5173 \
  --timeout 90 \
  -- python frontend/tests/ui_test.py
```

The test reads these environment variables (defaults in parentheses):

| Variable          | Meaning                                          |
| ----------------- | ------------------------------------------------ |
| `UI_BASE_URL`     | Frontend URL to test (`http://localhost:5173`)   |
| `SEED_CARD_COUNT` | Expected seeded story cards (`5`)                |

## API base

The frontend fetches `${VITE_API_BASE || ""}/api/clusters`. With no
`VITE_API_BASE` it uses the same origin (the dev proxy); with one, it hits
that server directly (as the seeded UI test does).

## How the UI is organized

- `src/components/` — `StoryCard` (grid card), `StoryModal` (full details with
  focus trap), `HeroImage` (og:image → favicon fallback), `badges` (shared
  source-count / status / tone chips), `ErrorBoundary` (brutalist fallback).
- `src/hooks/` — `useClusters` polls `/api/clusters` with request
  supersession, abort-on-unmount and exponential backoff (1s → 60s), and
  pauses while the tab is hidden.
- `src/types.ts` — API models, category metadata, tone colors, and small
  helpers (`timeAgo`, `faviconUrl`, `framingStatus`, …).
- `src/test/` — Vitest setup (jest-dom matchers).