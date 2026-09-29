# packages/db

Drizzle over postgres.js, server-only. `src/schema/` is the schema (`pgSchema("wms")`), `migrations/` the SQL the migrator applies, `src/seed/` the demo tenant, and `src/commands/` the write statements the API and the worker share.

Read `migrations/README.md` before adding a table, a column or a migration. It is the rulebook: who writes which statement, how keys carry the tenant, the file layout, and why a merged migration is never edited.

- There are two URLs. `DATABASE_ADMIN_URL` is the owner, for migrations, bootstrap and tests; `DATABASE_URL` is the API's role, `wms_api`. Migrations always run as the owner, because default privileges bind to the role that grants them. `wms_worker` reads across companies for the worker's sweeps, and `wms_sync` replicates for PowerSync.
- Every table spreads the column sets in `src/schema/columns.ts` and carries its hand-written statements: the tenant fence (RLS), and either the `updated_at` trigger or, for a ledger (`recorded_at`), the revoke. `src/__tests__/hand-written.test.ts` fails with any missing statement printed verbatim; paste it below drizzle-kit's statements in the migration that created the table.
- A status or kind is text with a CHECK over the domain's tuple (`oneOf` in `src/schema/checks.ts`), which a new value changes in one constraint.
- A reference carries the tenant, and between project-scoped tables the project too, through `src/schema/references.ts`.
- Every object name goes through `src/names.ts`, which refuses a name longer than Postgres's 63 bytes where Postgres would truncate it silently.
- A statement Drizzle cannot build is a pure function in `src/sql/` with a test over its text.
- `withCompany(db, companyId, fn)` (`src/tenant.ts`) takes the pool and refuses a transaction, since the setting it makes would outlive a savepoint's release.
- Through the raw `sql` face, timestamps come back as Postgres text and a `Date` parameter is refused.
- A statement both processes run throws `Refused` (`src/commands/shared.ts`); each process turns it into its own answer.
- `pnpm db:seed` writes on fixed UUIDv7 ids (`DEMO_IDS`, `src/seed/demo.ts`), so a test can name a seeded row without looking it up, and an upsert that would change nothing writes nothing. Its User Accounts are also the Pilot's, whose Logins carry the same reserved `.example` addresses, so an address changed here needs the owner to rename that Login on the Pilot. It writes configuration and identity only (#143): a reset leaves the tenant configured, never run. A set the API replaces whole under ids it mints — a calendar's holidays, a group's picks — goes through `replaceSets` (`src/seed/upsert.ts`), keyed by its content, so the next run survives the first edit made through the product.
- The tests run against a real Postgres. The rendering tests pin DDL without one; the rest create a fresh database per file or share the local one, and `src/__tests__/specimen.ts` runs a specimen table inside a transaction that always rolls back.
- The reset to the seed (`src/reset-to-seed.ts`) sweeps every table of the schema in its foreign-key order except the eight in `KEPT_TABLES`, Organisation & Access, so a new table is swept without asking. A new table that belongs with the accounts, which a reset must keep, goes into `KEPT_TABLES`.
