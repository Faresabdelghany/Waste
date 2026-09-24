# Migrations

Plain SQL files, applied in journal order by `src/migrate.ts` (`pnpm db:migrate`), never by `drizzle-kit push`. Two kinds of statement live here, and the rule for how they share a file is the point of this document.

## Who writes what

**drizzle-kit writes** what it has a builder for: `CREATE TABLE` with its columns, defaults, primary and foreign keys, unique constraints, indexes and `CHECK` constraints (including `validPeriod` and `validGeometry`), and the `ALTER TABLE` statements of a later change to those. `pnpm db:generate` diffs `src/schema/index.ts` against `meta/<last>_snapshot.json` and writes the next file, its snapshot and the journal entry. It never reads a `.sql` file back and never looks at a database, so what is appended to its file is invisible to it.

**Hand-written statements** are everything the database needs that Drizzle cannot express. The foundation (`0001_foundation.sql`: extensions, functions, the API role, grants) was written by hand as a whole. From the first domain table on, every table needs three kinds of statement beside what drizzle-kit generated, and a helper in `src/sql/` spells each so no two tables spell it differently:

| Statement | Helper | When |
|---|---|---|
| Row-level security enabled and forced, one policy over `company_id` for `wms_api` | `tenantFence(table)` | Every table (every table carries `company_id`) |
| The `BEFORE UPDATE` trigger on `wms.touch_updated_at()` | `touchUpdatedAt(table)` | Every table that spread `timestamps` |
| The `btree_gist` exclusion constraint over the business key and the validity range | `excludeOverlapping(table, [keyColumns])` | Every table that spread `validity` (which must also carry the `validPeriod` check); `company_id` leads the key, and every key column is `NOT NULL`, since a null never equals anything in an exclusion constraint |

Drizzle can describe policies (`pgPolicy`) and RLS; they are not used, so each of these statements has one owner and one spelling.

## Keys: a reference carries the tenant

An intra-tenant reference is a **composite foreign key that includes `company_id`**: `(company_id, project_id) → project (company_id, id)`, `(company_id, role_id) → role (company_id, id)`, and so on. A row therefore cannot reference another company's record, whatever the API does, and the database refuses the attempt with 23503. Every table referenced this way carries `unique (company_id, id)` for the key to point at. Only `company_id → company (id)` itself is a plain key, and `company` is its own tenant (`company_id = id`, the `company_self` check), so the fence applies to it like to every other table.

drizzle-kit writes these (they are foreign keys and unique constraints), but its default names would not do: `<table>_<columns>_<foreign table>_<foreign columns>_fk` overruns 63 bytes on a composite key, and Postgres truncates an identifier silently. So every key is named explicitly through `src/names.ts` by the helpers in `src/schema/references.ts`: `companyReference(t, company)` for the plain key, `tenantReference(t, [t.roleId], role)` for a composite one (`<table>_<columns>_fk`), `tenantKey(t)` for the `unique (company_id, id)` a reference points at (`<table>_tenant_key`), `tenantUnique(t, ...columns)` and `uniqueOn(...columns)` for business keys (`<table>_<columns>_key`, Postgres's own suffix, the tenant column left out of the name — and where listing the columns would pass 63 bytes, the key is spelled inline with `unique(tableObjectName(...))` and named for what it holds instead, as `shared_collection_point_member_membership_key` is), and `tenantIndex(t, ...columns)` for a referencing column set no unique constraint leads with (`<table>_<columns>_idx`; Postgres indexes only the referenced side of a foreign key). A check over a text column is `oneOf(column, values)` or `lowercase(column)` from `src/schema/checks.ts`; a count is `positive(column)` (null passes, since nothing recorded is not zero) and a one-of-two column pair `exactlyOne(t, label, [a, b])` (`(a is not null)::int + (b is not null)::int = 1`, named `<table>_<label>_exactly_one`). Each is named `<table>_<column>_<rule>`, or `<table>_<label>_<rule>` where the rule is about several columns at once. A name past 63 bytes is refused when the table is defined, with the fix in the message.

### And a project-scoped reference carries the project

Where **both** tables are project-scoped the key carries `project_id` as well: `(company_id, project_id, property_id) → property (company_id, project_id, id)`, so a subscription cannot name a property of another project any more than of another company, and a placement cannot name another project's container. That is `projectReference(t, [t.propertyId], property)`, named `<table>_<columns>_fk` like the tenant's, and the referenced table carries `unique (company_id, project_id, id)` for it: `projectKey(t)`, named `<table>_project_key`. Both leave `company_id` and `project_id` out of the name, since every key of a project-scoped table begins with them.

A reference from a project-scoped table to a company-wide one — an agreement's customer, a placement's waste fraction, a product's container type — stays a `tenantReference`: the target has no project to agree on. A table nothing references needs no key of its own (`property_party`, `container_service_placement`), and `projectKey` is what a table gets when something will point at it.

## Layout: the same file, below drizzle-kit's statements

A table's hand-written statements go into **the migration file that creates the table**, after drizzle-kit's statements, each preceded by its own `--> statement-breakpoint` line (the migrator splits the file on that marker and runs each piece as its own statement, all in one transaction). Not into a paired `--custom` file: the table and its fence are one change and land in one journal entry, so no database is ever left with the table applied and the fence not, and a reader finds the whole table in one place.

The recipe for a new table:

1. Define it in `src/schema/<context>.ts` from the column sets in `src/schema/columns.ts` (`id`, `tenant` or `projectScoped`, `timestamps`, `validity` with `validPeriod(columns)` in the extra config) and the key helpers in `src/schema/references.ts` (every reference to another table of the tenant a `tenantReference`, `tenantKey` where a reference will point at it), export it from `src/schema/index.ts`.
2. `pnpm db:generate` writes `NNNN_<name>.sql`.
3. Append the hand-written statements to that file: `tenantFence`, `touchUpdatedAt` where there is `updated_at`, `excludeOverlapping` where there is validity. Copy the helper output verbatim.
4. `pnpm --filter @waste/db test`. The gate in `src/__tests__/hand-written.test.ts` reads every migration the way the migrator does (split at the breakpoints, comments dropped, whitespace collapsed), finds the file whose statements create each table of the schema, and fails with the missing statements printed verbatim when the file lacks one; paste what it prints. A statement wrapped over several lines counts; one commented out, or sharing a breakpoint piece with another, does not.
5. `pnpm db:migrate` locally; CI applies the same to its stack.

What the file looks like once complete (a specimen; the constraint's key is the table's own):

```sql
CREATE TABLE "wms"."agreement" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"container_id" uuid NOT NULL,
	CONSTRAINT "agreement_validity" CHECK ("wms"."agreement"."valid_to" is null or "wms"."agreement"."valid_to" > "wms"."agreement"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD CONSTRAINT "agreement_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "container_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."agreement" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "agreement_tenant_fence" ON "wms"."agreement" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "agreement_touch_updated_at" BEFORE UPDATE ON "wms"."agreement" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
```

A ledger (append-only) has no `updated_at` and no trigger; its `REVOKE UPDATE, DELETE ... FROM wms_api` is hand-written the same way when the first ledger arrives.

Anything else the database needs that is not a table's goes below the tables' statements in the same file, as `0002_organisation_access.sql` carries the access token hook and its grants below the eight tables' fences and triggers. A function that changes is replaced whole, in a new file, with `CREATE OR REPLACE FUNCTION` and its definition restated in full (`SECURITY DEFINER` and `SET search_path` are part of it), as `0005_hook_email.sql` replaces the hook below the index drizzle-kit wrote; the owner and the privileges survive the replacement, so the grants and revokes of the earlier files stand and are not repeated. drizzle-kit itself writes `--> statement-breakpoint` at the end of an `ALTER TABLE` or `CREATE INDEX` line; the migrator, and the gate, split on the marker wherever it stands.

## Two rules the migrator cannot enforce

- **Never edit a file that has been applied anywhere** (the local stack counts, and so does the hosted project). The migrator records each file's sha256 when it applies it and never compares hashes afterwards, so an edit is silently not applied. A change to an applied table is a new file: `pnpm db:generate` for what drizzle-kit can express, `pnpm --filter @waste/db exec drizzle-kit generate --custom` for an empty file to hand-write into.
- **The journal is append-only and monotonic.** `src/__tests__/journal.test.ts` refuses a file the journal does not list and an entry whose `when` is not later than the previous one; the migrator would otherwise skip it forever.

Unqualified names in a generated file (`geometry(Point, 4326)`) resolve through the search path the migrator pins, `wms, extensions`; hand-written statements qualify what they name.
