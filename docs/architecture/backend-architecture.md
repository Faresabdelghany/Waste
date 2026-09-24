# Backend architecture

Status: agreed 2026-09-17. This repository is the monorepo of a new system built from scratch: it began as the system's frontend, now `apps/web`, and the backend described here is built beside it, `apps/api` first. This document describes that backend. The five invariants and the optimiser choice are recorded as ADRs under `../adr/`; stack choices and their rejected alternatives live in the table below. This document is the readable whole and is updated when an ADR changes it. Terms follow `CONTEXT.md`.

## Bounded contexts

Derived from the glossary. Each context owns its tables and exposes commands and read models; other contexts reference its records by id only.

| Context | Owns | Defining trait |
|---|---|---|
| Organisation & Access | Company, Project, User account, Role and its grants, Project Access, Service Provider (the external organisation itself: legal name, registration number, country, contact), Service Provider Access, Company Administrator | The tenant is the Company. A Service Provider's users belong to another organisation and see only their currently assigned Service Areas. |
| Registry | Customer, Property, Property Group, Shared Collection Point, Agreement, Subscription, Service frequency, Product / Service, Container Service Placement | Effective-dated entitlements. Service frequency is inherited by query, never copied. |
| Resources | Vehicle (with compartments), Driver, Vehicle Allocation, Warehouse, Depot, Unloading Station, Stock Movement, Container Asset State | Two append-only ledgers: Stock Movements and Vehicle Allocations. Asset State is a projection. |
| Planning | Collection Calendar, Route Scheme, Collection Group, Stop Matching Rule, Planning Area, Scenario, Plan | Stores rules and immutable optimisation results (Plans), never generated work. Generation is a job. A Route in Execution references at most one active Plan. |
| Execution | Route, Planned and Actual Assignment, Pickup, Session, Proof of Service, Unload | Connectivity can disappear at any point in a shift. Pickup is one record from planning through execution; proof and unloads are appended. |
| Resolution | Ticket, Alert | Created from execution events. |
| Finance & Contracting | Billable Event, Billing Run, Invoice, Settlement, Price List, Service Area, Service Area Assignment | A pipeline from Pickup to Invoice. Everything effective-dated. A Service Provider's areas, assignments, prices and settlements are here; the organisation record itself is Organisation & Access's, because an access grant needs the organisation it grants for. |

Intelligence (Insight, Suggestion, Approval) and Promotion / Go-live are glossary terms with no schema in the first version. Activating a Plan on a Route (ADR-0002) is not Promotion; Promotion is the larger process of turning an approved plan into production configuration.

## Invariants

These are architectural constraints, not implementation preferences. Each has an ADR.

1. **Single domain data path.** Domain tables are not reachable from the browser. The Hono API is the web boundary; authorisation and business rules live behind it. Row-level security is a backstop, never the place the model is implemented. ADR-0001.
2. **Generation is not optimisation.** Generation deterministically establishes what work exists on a service date. Optimisation produces a Plan over that work and never rewrites the generated baseline. ADR-0002.
3. **Container lifecycle consistency.** One Container identity, a Service Placement in Registry, an Asset State projected from the Stock Movement ledger, and lifecycle commands that update both contexts atomically. ADR-0003.
4. **Offline execution.** Every driver action is an idempotent, client-identified command that survives hours without connectivity and is applied server-authoritatively later. ADR-0004.
5. **Effective dating.** Every effective-dated concept uses validity periods with database-enforced non-overlap, evaluated as of a date at query time. ADR-0005.

## Deployment shape

```
 Web (Next.js, this repo)          Driver app (Expo)
          |                               |
          |  HTTPS, OpenAPI               |  PowerSync sync + HTTPS commands
          v                               v
 +--------------------------------------------------+
 |  Hono API, this repo (identity from Supabase JWT, |
 |  scoped repositories, domain package, Drizzle)    |
 +--------------------------------------------------+
          |                      |
          v                      v
 Supabase Postgres + PostGIS   pg-boss worker
 schema `wms` (not exposed)    generation, lifecycle, outbox relay
 Supabase Auth, Storage            |            |
          |                        v            v
     PowerSync service          Valhalla     PyVRP sidecar (ADR-0006)
     (logical replication)      routing      behind one HTTP contract
```

## Stack

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| Web | Next.js 16, React 19, TypeScript, shadcn/ui, Tailwind v4 | Already built. |
| API | Hono with hono-openapi and zod 4 | Zod schemas shared with the web forms. OpenAPI 3.1 is the contract for the driver app and third parties. tRPC has no first-party OpenAPI. ts-rest is unmaintained. Server Actions are Next-only. |
| Database | Supabase Postgres 17 with PostGIS, Stockholm (`eu-north-1`) | PostGIS for container points, planning-area and service-area polygons, route geometry. Supabase chosen as platform; Neon was the alternative. |
| Auth | Supabase Auth, tokens verified with jose | Its JWT is consumed natively by PowerSync and RLS. It has no organisation model, so Company, Project Access, Service Provider Access, and roles are our tables. The only claim of ours on the JWT is the home company id, which the custom access token hook adds; the user id is Auth's own subject, and grants are looked up per request. The API verifies an access token against the project's published JWKS (asymmetric keys, ES256 on `waste-dev`) through jose's cached remote key set, so it holds no shared secret and key rotation needs no restart; Hono's own JWK middleware refetches the key set on every request. Better Auth was the alternative and is the fallback if the platform changes. |
| ORM | Drizzle 0.45 | Typed SQL, transactions for multi-table commands. Geometry as GeoJSON through a custom type that drizzle-kit renders as written (`geometry(Point, 4326)`; Drizzle's own geometry column is not used, since drizzle-kit rewrites its polygon form to point). Hand-written SQL only for what Drizzle has no builder for: extensions, functions, roles, exclusion constraints, policies. Prisma rejected: PostGIS columns are unsupported in its client. |
| Jobs | pg-boss 12 | Same Postgres, same transaction as the rows it produces, cron built in. Needs the direct connection or session pooler, never the transaction pooler. Worker hosted outside Supabase (Railway or Fly). |
| Cross-context events | Outbox table relayed by the worker | No message broker. |
| Driver app | Expo with PowerSync | The only sync engine with offline writes, server-authoritative conflict handling, and an attachment queue on any Postgres. Zero rejects offline writes; Replicache is in maintenance mode. PowerSync's service is source-available under FSL: self-host or EU cloud. Fallback: plain Expo SQLite outbox. |
| Road routing | Valhalla, self-hosted | Truck costing, distance matrices, map-matching, MIT. Denmark extract is about 470 MB. The public OSRM demo server is non-commercial, one request per second, no uptime guarantee: prototype only. |
| Optimisation | PyVRP 0.14 as a Python sidecar behind one HTTP contract (ADR-0006) | Multi-dimensional capacity plus reloads in one model, verified by spike. Its reload empties every compartment, which matches Danish and Swedish practice. The only non-TypeScript component; OR-Tools replaces it behind the same contract if partial unloading is ever required. ADR-0006. |
| Map data | GeoJSON with client clustering; Martin vector tiles above roughly 50k features | Martin is maintained by the MapLibre organisation. pg_tileserv has stalled. |
| Danish addresses and basemap | Adressevælger (autocomplete), Datafordeleren (reverse geocoding, DAR, DAGI polygons), Dataforsyningen Skærmkort vector tiles | DAWA shuts down 2026-10-01. Every provider URL sits behind one config seam. |
| Monorepo | pnpm 12 workspaces with Turborepo | Web, api, worker, driver apps; domain, contracts, db packages; a development-only tooling package for the purity gate. |
| Tests | Node's built-in runner through tsx, Playwright | The unit suite already ran on it when this was decided. No migration to Vitest. |

## Data model rules

- Domain tables live in schema `wms`, which is not in Supabase's exposed schemas. RLS policies on them are coarse tenant fences; the API sets request claims per transaction so the backstop is real.
- The API connects as `wms_api`, which owns nothing and bypasses nothing, so every policy and default privilege applies to it; migrations run as the owner.
- Every table carries `company_id`; project-scoped tables carry `project_id`. Service Provider visibility is resolved through Service Area Assignment validity, never denormalised onto rows.
- An intra-tenant reference is a composite foreign key that carries the tenant: `(company_id, project_id) → project (company_id, id)`, `(company_id, role_id) → role (company_id, id)`, and so on, so every table referenced this way carries `unique (company_id, id)` for the key to point at. Only `company_id → company (id)` itself is a plain key, and `company` is its own tenant (`company_id = id`). A row therefore cannot reference another tenant's record whatever the API does; the database refuses it.
- Supabase Auth is the identity provider and sign-up is invitation-only. The custom access token hook adds the one custom claim, `app_metadata.company_id`, the caller's home company; the API verifies the token against the project's JWKS and looks the caller's account and grants up on every request inside `withCompany`, so a revocation takes effect on the next call and RLS stays the backstop.
- Effective-dated tables use `valid_from` and nullable `valid_to`, half-open, with a `btree_gist` exclusion constraint per key.
- Generated Routes are unique on route scheme, collection group, and service date. Generation is idempotent.
- Pickup is a current-state row. Proof of Service and Unload are append-only rows referencing the Route or Pickup.
- Stock Movement and Vehicle Allocation are append-only. Asset State is projected.
- Derived rows (list columns, KPI tiles, matched containers) are computed, never persisted.
- Ids are UUIDv7, generated by the client for anything a driver can create offline.

## Build order

1. **Now, in parallel with everything:** request the Adressevælger token from Klimadatastyrelsen and a Dataforsyningen token; snapshot municipality and postcode GeoJSON from DAWA before 2026-10-01.
2. **Monorepo.** Done in the repository 2026-09-17; the deployment's root directory and an e2e run against the moved app are still open. This app is `apps/web`. The domain logic of `lib/route-schemes` (all of it) and of `lib/map-planning` (the planning questions; the map-view mechanics stayed in `apps/web/lib/map-planning`), with the pure record helpers from `lib/data`, is `packages/domain`, kept free of every dependency and browser global by a mechanical purity gate in the development-only `packages/tooling`. `packages/contracts` holds the shared wire primitives on zod 4, and `apps/api` was a Hono scaffold serving its health and its OpenAPI 3.1 document; the root `CLAUDE.md` describes the layout. The module contracts derived from the form schemas were not built here: each context's arrive with its tables, from step 3 on.
3. **Organisation & Access and Registry schema.** The database foundation came first in the repository, 2026-09-18 to 2026-09-24: `packages/db` on Drizzle over Supabase Postgres 17 with PostGIS, one container from one command locally and on every CI run, where a database test may not skip. It holds schema `wms`, unexposed and revoked from `PUBLIC`; `wms.uuidv7()` as every id's default; the column sets a table spreads (`company_id` and `project_id`, `created_at` and `updated_at`, `valid_from` and `valid_to`); the three statements Drizzle has no builder for, each spelled by one helper and required of every table's own migration file by a test: the exclusion constraint over the key and the validity range, the tenant fence (row-level security forced, one policy for `wms_api` on the company a transaction sets, which is what `withCompany` does) and the `updated_at` trigger; geometry columns typed as the contracts' GeoJSON `Point` and `Polygon` in SRID 4326 and checked valid in the database; `validOn`, the query-side reading of a validity period as of a day; and `apps/api` connected as `wms_api`, answering `GET /readyz` for the database. The hosted project carries the same foundation. Organisation & Access landed on that foundation in the repository, 2026-09-24: eight tables in migration `0002_organisation_access` — `company` (its own tenant, `company_id = id`), `project`, `service_provider`, `role`, `role_grant`, `user_account`, `project_access` and `service_provider_access` — each with its tenant fence and `updated_at` trigger, keyed by the composite rule above, statuses as text with a check rather than an enum, and nothing effective-dated, so the exclusion helper is still unused; `public.custom_access_token_hook`, in the same migration, which binds an invited account to its login by e-mail on first sign-in, refuses a deactivated one, and puts `app_metadata.company_id` into every token Auth issues, refresh included; a seed (`pnpm db:seed`, idempotent, fixed UUIDv7 ids) that writes the demo company, its projects and providers, the eleven system roles with their grants and the two demo accounts, so the local database and the hosted project hold the same tenant; the API's request path — the bearer token verified against the project's JWKS, then the caller's account, role, grants, projects and provider resolved inside `withCompany` on a per-request transaction the handler runs in, the grant checked per route, and every error an RFC 9457 problem; and the routes themselves, `GET /me` beside the organisation resources (company, projects, service providers) and the access resources (users, roles and their grant matrix), ids minted by the server and lists paged by a cursor over them. The first module contracts came with them, into `packages/contracts`: `permissions`, `problem`, `me`, `organisation` and `access`. Still owed here: the Registry tables, effective-dated on the foundation's sets, with the citizen portal's customer-side identity among them — a Registry read model, not an account — and the module contracts derived from their form schemas. The project's working week and holiday list, which the prototype keeps on its project record, arrive as columns on `project` with Planning. Line strings arrive with the first stored route leg, a ledger's `REVOKE UPDATE, DELETE` with Resources, and where the prototype's unclosed `{ lng, lat }[]` boundaries become rings is decided with the first table that stores a polygon.
4. **Frontend adapter.** A server-backed implementation behind the record store's `getRecords` and `upsertRecord`, switched module by module. Fixtures become seed data.
5. **Planning and the generation worker.** Nightly cron plus on-demand, Valhalla for legs.
6. **Execution.** Proof of Service and Unload, outbox, Expo driver app on PowerSync, live dashboard.
7. **Resolution and Finance** from the outbox, then the e-conomic export.
8. **Optimisation and import tooling** once real routes exist.

## External deadlines and dependencies

- **DAWA closes 2026-10-01 10:00.** Gsearch closes 2026-11-01. Replacements are Adressevælger, Adressevask, and Datafordeleren, all from Klimadatastyrelsen, CC BY 4.0 with attribution.
- PowerSync needs logical replication on the Supabase project.
- The pg-boss worker and Valhalla need a host outside Supabase.

## Sources (verified 2026-09-17)

- DAWA shutdown: https://www.klimadatastyrelsen.dk/om-klimadatastyrelsen/nyheder/nyhedsarkiv/2026/jul/dawa-lukker-d-1-oktober-2026
- Prisma PostGIS: https://github.com/prisma/prisma/issues/2789
- Drizzle polygon migration bug: https://github.com/drizzle-team/drizzle-orm/issues/3040
- Auth.js maintenance mode: https://better-auth.com/blog/authjs-joins-better-auth
- Supabase custom claims and RBAC: https://supabase.com/docs/guides/database/postgres/custom-claims-and-role-based-access-control-rbac
- PowerSync conflicts and attachments: https://docs.powersync.com/usage/lifecycle-maintenance/handling-update-conflicts , https://docs.powersync.com/usage/use-case-examples/attachments-files
- Zero offline limits: https://zero.rocicorp.dev/docs/offline
- OSRM demo server terms: https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server
- Valhalla: https://github.com/valhalla/valhalla/releases
- PyVRP reloading: https://pyvrp.org/notebooks/reloading.html
- Martin: https://github.com/maplibre/martin/releases
- pg-boss 12: https://github.com/timgit/pg-boss/releases/tag/12.0.0
- MapLibre large data guidance: https://maplibre.org/maplibre-gl-js/docs/guides/large-data/
