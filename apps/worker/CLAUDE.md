# apps/worker

The pg-boss worker (ADR-0007), run from TypeScript source through tsx. `src/main.ts` is the composition root; `/healthz` and `/readyz` are its only routes.

- pg-boss is pinned exactly, here, in `packages/db` and in `apps/api`, which sends the office's jobs. Its schema comes from migration 0011 and the worker starts it with `migrate: false`, so a pg-boss upgrade that moves its schema version needs a new migration; `packages/db`'s `worker-rendering.test.ts` fails until the migration exists.
- A job is a file in `src/jobs/` that exports `defineJob({ ... })`, plus one line in `JOBS` (`src/jobs/index.ts`). An outbox consumer is `...defineOutboxConsumer({ ... })` from `src/outbox/subscribe.ts`, one consumer per kind, receiving a parsed `RelayedEvent` on the `outbox.<kind>` queue that the relay `send`s to.
- The decisions are pure functions in `@waste/domain`, and the job is the I/O around them.
- A job writes as `wms_api` under `withCompany` on `context.api`, fenced exactly like a request. `context.worker` (`wms_worker`: read-only, bypasses RLS) serves only the sweeps that read across companies.
- A consumer job that fails past its retries is copied to `outbox.dead`, which `/readyz` counts as `deadLetters`. Once the cause is fixed, `boss.redrive("outbox.dead", …)` runs it again on its own queue.
- Tests are `src/**/*.test.ts`. A suite whose sweep crosses companies creates a database of its own (`src/__tests__/database.ts`), so it never touches another suite's rows.
