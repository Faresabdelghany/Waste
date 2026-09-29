# CLAUDE.md

Waste is a waste and recycling operations platform: a pnpm + turbo monorepo under the `@waste/*` namespace.

- `apps/web` — the Next.js prototype. It runs on fixture records and browser storage, and is being switched onto the API one module at a time.
- `apps/api` — the Hono API, the only way the web reaches domain data (ADR-0001).
- `apps/worker` — the pg-boss worker: route generation, the outbox relay and its consumers, scheduled billing.
- `packages/` — shared code, see Workspace packages.

The target backend is described in `docs/architecture/backend-architecture.md`, decisions are in `docs/adr/`, and the glossary is `CONTEXT.md`.

This file, and the `CLAUDE.md` in `apps/web`, `apps/api`, `apps/worker` and `packages/db`, is a **map**: where things live, how to run them, and the rules you would get wrong from reading the code alone. The nested files load when you read files in their directory. Each line costs context in every session, so add a rule only when it would otherwise be rediscovered the hard way. Leave behaviour, counts and history to the code, its tests and `git log`.

## Commands

Scripts live in each `package.json`; these are the ones with a catch.

- `pnpm dev` — web on :3000, API on :3001, worker probes on :3002, through turbo. The API needs `DATABASE_URL` and `SUPABASE_URL`. The worker needs `WORKER_DATABASE_URL` and `DATABASE_URL` through a session pooler; it refuses port 6543, the transaction pooler.
- Environment — turbo runs in strict env mode: a variable reaches a task only when `turbo.json` lists it on that task. A new variable goes into `turbo.json` beside the app's `env.ts`. The root `.env` reaches the API, the worker and the `packages/db` scripts through `--env-file-if-exists=../../.env`, and the shell wins over the file.
- `pnpm typecheck` — TypeScript 7's native `tsc`. `next build` skips type errors (`ignoreBuildErrors`), so run it explicitly. The `typescript` package is TypeScript 6 because ESLint's parser needs its JavaScript API.
- `pnpm lint` — one flat config, `eslint.config.mjs`. Everything but `apps/web` runs with `--max-warnings 0`, and a rule switched off carries its reason in a comment.
- `pnpm test` — `node:test` through tsx, package by package. A suite that needs Postgres skips with the reason when its URL is unset, and fails instead under `REQUIRE_DATABASE=1`, which CI sets. Database tests accept loopback URLs only.
- `pnpm db:start` / `pnpm db:stop` — the local Postgres 17 + PostGIS container, `supabase_db_waste` on port 54322, from `supabase/config.toml` (the database alone, no Auth). Then run `pnpm db:migrate`, then `pnpm db:bootstrap` (local logins for the app roles), then `pnpm db:seed` (the demo tenant Kystbyen Renovation; idempotent, on fixed ids). `pnpm db:generate` is `drizzle-kit generate`, and the schema reaches a database only through migrations. `pnpm db:check` compares the applied journal with the files; a local database that fails it is reset (`db:stop --no-backup`, then the four steps again).
- `pnpm test:e2e` — Playwright against a dev server you have started on :3000. In CI the job builds and serves the app itself.
- `docker build -f apps/api/Dockerfile .` and `docker build -f apps/worker/Dockerfile .` — run from the repository root, since each image carries the source of the workspace packages it runs. They deploy to Fly.io (ADR-0007), with a `fly.toml` beside each Dockerfile.
- When volta's pnpm shim fails with "Could not find executable", `npm run <script>` works against the installed `node_modules`.

## The Pilot's database

The hosted Supabase project, the Pilot, changes only through `.github/workflows/pilot-database.yml`. Each run is one fixed operation (`check`, `release`, `grant-logins`, `restore`, `repair`, `recover-logins`) under the `pilot` environment, which the owner approves. The procedures are in `supabase/README.md`. The rule that a merged migration is never edited, and how a mistake is repaired instead, are in `packages/db/migrations/README.md`.

## Workspace packages

Every package ships TypeScript source (`exports` maps `./*` to `./src/*.ts`) and has no build step. Turbopack and tsx read the source directly, which is why the API and the worker run through tsx and their images copy each package's `src/`. `__tests__` directories are hidden from consumers by `null` exports.

Dependencies point inward: `domain` depends on nothing, `contracts` on zod and the domain's vocabularies, `db` on both. `apps/web` reaches data only through the API; ESLint refuses `@waste/db`, `drizzle-orm` and `postgres` there.

- `packages/domain` — the pure business rules, gated by `src/__tests__/purity.test.ts` (from `@waste/tooling/purity`): relative imports only, no browser or Node globals.
  - Each context's closed lists are `as const` tuples in `src/<context>/vocabulary.ts`. The database's CHECK and the contracts' `z.enum` both read the same tuple, so a value is added in one place, as a kebab-case token.
  - Occurrences come from one function, `generateOccurrences` (`route-schemes/occurrences.ts`), which the web preview, the API's occurrence read and the worker's generation all call; extend it rather than write another.
  - A Route's identity is its scheme, collection group and service date (ADR-0002). A holiday shift moves only the operating date; the service date stays as generated.
  - Periods are half-open (ADR-0005): `validTo` is the first day out of force. The route-scheme code's `effectiveTo` is the last day in, one day earlier.
  - Money is integer minor units, rounded only through `finance/money.ts`, whose half-away-from-zero rule matches Postgres's `round(numeric)`.
- `packages/contracts` — the zod 4 wire schemas the web and the API share, written `import * as z from "zod"`. Its purity test lists exactly which domain modules it may import.
  - Write bodies are `z.strictObject`, so a member the server owns is refused by name. A patch is all-optional under `changesSomething`. Codes such as country, currency and timezone are checked by shape.
  - The web imports these schemas as types only, since a runtime zod import would add about 90 KB gzipped to every workspace route; zod itself runs only in the web's tests.
- `packages/db` — Drizzle over postgres.js, server-only: schema, migrations, seed, and the write statements the API and the worker share. Its rules are in `packages/db/CLAUDE.md`.
- `packages/tooling` — development-only: the purity gate, and `databaseUnderTest`, the skip-or-fail rule every database suite goes through.

## Language and docs

- `CONTEXT.md` is the glossary. UI copy and identifiers use its exact terms, and each entry names the synonyms to avoid (Agreement vs Subscription, Route Scheme vs Route, Warehouse vs Depot, Ticket vs Alert). A Project is an operating scope — a municipality, a contract, a region — never a route.
- `docs/` holds the ADRs and the architecture document, under the rules in `docs/README.md`. Feature design lives on the GitHub issue.
