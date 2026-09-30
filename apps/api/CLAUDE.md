# apps/api

The Hono API (ADR-0001), run from TypeScript source through tsx. `src/app.ts` builds the app from injected pools, a token verifier and a clock; `src/server.ts` is the composition root. `GET /openapi.json` is generated from each route's `describeRoute`, so a route without one is missing from the published contract.

## A route

- Each authenticated route puts the principal guard (`src/auth/principal.ts`) and `requireGrant(moduleKey, action)` (`src/auth/require.ts`) before its handler, route by route rather than on a wildcard, so the probes stay open and an unknown path stays a 404.
- The handler works inside the request's transaction, `c.get("tx")`, which the guard opened under `withCompany`; it opens none of its own. The guard discards the transaction on an error or any status of 400 or above.
- One route is the exception: `POST /routing/preview` (#173) calls the routing provider, and no transaction is held across a provider call (#124 §4), since on the Pilot's small pool a connection idle through one starves the requests behind it. Its guard is `identify`, the same checks through the same function as `authenticate`, with the transaction ended before the handler, which opens two short `withCompany` transactions of its own, one on each side of the call.
- Every statement carries two fences: an explicit `company_id` (the API's own check, with RLS behind it) and the project fence, `inProjects(column, principal)` from `src/auth/projects.ts`. A row outside the caller's projects is the family's 404; a body or query naming a project the caller does not work in is a 400 on that field. The driver door fences by assignment (`src/auth/driver.ts`), and the pick lists of `GET /driver/me` by the driver profile's project or the company alone; a Service Provider's account reaches rows through `src/auth/provider.ts`.
- A token names its company in `app_metadata.company_id`, which the access token hook sets from the account bound to the login. Sign-up is invitation-only (`supabase/config.toml`).

## Answers

- Every error is an RFC 9457 problem (`src/problem.ts`): throw `problem(status, { detail, errors })`, and validate with `validate(target, schema)` over the contracts' schemas.
- A problem's type is `about:blank`, except the principal's two account refusals, `kind: NO_ACTIVE_ACCOUNT` (`@waste/contracts/problem`). The web ends the session on that type, so give it to no other refusal, a driver door's or a grant's 403 included.
- A body value that will not do is a 400 naming its field (`invalidRequest`). A row whose state refuses the command is a 409 with one sentence saying why. Judge in this order: the path's own row (404), its state (409), the body's fields (400), then the 409s that need the body.
- A database refusal goes through the doors in `src/routes/shared.ts`, each with the route's own sentence: `refuseDuplicate` (23505), `refuseOverlap` (23P01), `refuseCheck` (23514, as a 400) and `replayed` (an idempotent retry meeting a primary key). A client sees the sentence and never the constraint's name; an unmapped 23514 is a 500, which means a sentence is missing.
- A create answers 201 with `Location` through `created()` and declares it with `describeCreated`. An append to a ledger — a stock movement, a comment, a weight review — answers 201 without one. `src/__tests__/app.test.ts` counts the secured operations and the 201s; update it with each new route.
- A list answers `Page(item)` through `src/pagination.ts`: ordered by `id` (a UUIDv7, so creation order; newest first only where the route says so), with a cursor over `id`, no offsets and no total.
- The server mints the ids of web writes (`newId()`, `src/ids.ts`); a driver's command carries the id its device minted.

## Rules the API holds

- Take `lockRow` before reading a row whose rule the API holds, parent before child, and `lockRows` for a set (in id order). `wms_api` cannot row-lock a ledger row, since `FOR UPDATE` needs the UPDATE privilege it was denied, so lock the parent instead.
- A status gates a new reference, never an existing one (`src/routes/statuses.ts`).
- A child's period sits inside its parent's (`src/routes/periods.ts`): a child placed outside is a 400 at the bound, and a parent shortened under its children is a 409 counting them.
- Routes take the app's injected `now`. An instant becomes a day in the project's timezone through `src/routes/days.ts`, and a body's instant may run ahead of the clock by `OCCURRED_AT_SKEW_MS` at most.
- News for another context goes into the outbox through `emit()` (`src/outbox.ts`), in the request's transaction, after the rows it describes, with the wire resource as the route answers it for its payload.
- A statement the worker runs too lives in `@waste/db/commands` and throws `Refused`, which the error handler answers as the 409 or 400 it names.
- Work for the worker is a pg-boss job sent in the request's transaction through `@waste/db/jobs` (`sendGenerateRoutes`, `sendInTransaction`), so it commits with the rows that asked for it. The API runs no pg-boss: `createApp` builds one sender over the probe pool, never the request pool, and never starts it (`jobs`). The worker creates every queue when it starts; the API creates none, and answers 503 on a database whose worker has not (`QueueMissing`). The generation trigger takes no lock on the scheme, since the worker holds it for a whole run; pg-boss's singleton key is the serialisation, and the run it answers is the one whose job pg-boss still holds (`jobHeld`).
- A new environment variable goes into `src/env.ts` and onto the API's tasks in `turbo.json`.

## Tests

- `src/**/*.test.ts`. A suite on the shared local database mints its own tenant (`src/__tests__/tenant.ts`) and removes it with `dropTenant`; a suite that writes a ledger hands `dropTenant` the owner's pool (`DATABASE_ADMIN_URL`), since `wms_api` cannot delete ledger rows. Tokens are signed against a key set each test generates (`src/__tests__/tokens.ts`), and calls go through `callingAs` (`src/__tests__/calls.ts`).
