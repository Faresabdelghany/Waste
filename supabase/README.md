# The Pilot's Supabase project

This directory holds the local stack's configuration (`config.toml`, read by `pnpm db:start`) and the age recipient the Pilot's backups are encrypted to (`pilot-backup.pub`). This file is the operator's runbook for the **Pilot** — the hosted environment on the one Supabase project, `waste-pilot` — and its sections are the procedures an operator follows by hand. The infrastructure unit is always written the Supabase project here: a bare Project is the domain's (`CONTEXT.md`).

## The database door

Every owner-level action on the Pilot's database goes through one workflow, `.github/workflows/pilot-database.yml` (Issue #152, decided in #133). Nothing else holds the owner's connection string: not a developer's machine, not the Supabase CLI, not an MCP session. The workflow is dispatched by hand on `main`, runs one fixed operation per run, and every operation's job runs under the `pilot` environment, which the repository owner approves before the job may read a secret.

| Operation | What it does | Inputs |
|---|---|---|
| `check` | Journal check, the fingerprint against the committed file (once nothing is pending), the service roles' LOGIN state and the `powersync` publication against the synced tables. Writes nothing. | — |
| `release` | A Pilot release: the steps below. | `run_seed` (default off), `deploy_api` (default on) |
| `reset-to-seed` | Reserved for #142's sweep and re-seed inside the write barrier; fails until that lands. | — |
| `grant-logins` | LOGIN for exactly `wms_api` and `wms_worker` with the environment's app-role passwords. | — |
| `restore` | A named run's backup restored inside the write barrier. | `source_run_id`, `services_suspended` |
| `repair` | One allow-listed repair module. | `repair_id` |
| `recover-logins` | The LOGIN states a restore or reset recorded, put back after it failed or was cancelled. | `source_run_id` |

No input is SQL, a shell command or a path; a run id and a repair id are validated before any step uses them. To dispatch: Actions › Pilot database › Run workflow, branch `main`, choose the operation, then approve the job when GitHub asks (Review deployments › `pilot` › Approve). From a terminal: `gh workflow run pilot-database.yml --ref main -f operation=check`.

### What the environment holds

- **Environment `pilot`**: deployment branch `main` only; required reviewer the repository owner; self-review prevention **off**, since one person dispatches and approves — this is a one-person approval boundary, not a two-person control; no wait timer.
- **Secrets** (environment): `PILOT_DATABASE_ADMIN_URL` — the `postgres` role's Session pooler string from the dashboard's Connect dialog (host copied, never derived; user `postgres.<ref>`, port 5432, the password percent-encoded, `?sslmode=require`); `PILOT_BACKUP_AGE_KEY` — the age identity whose recipient is `pilot-backup.pub`; `PILOT_RENDER_DEPLOY_HOOK` — Render's deploy hook, once the hosting issue (#149) creates the service; `PILOT_DATABASE_URL` and `PILOT_WORKER_DATABASE_URL` — the app roles' session-pooler URLs, the ones Render runs with.
- **Variable** (repository): `PILOT_API_URL`, the API's public origin, read by `release` to prove a deployment live (and by the keep-alive).
- **Constants** (in the workflow, reviewed with it): the Supabase project ref, the pooler host and the GHCR package. Every script holds the secret URL to the ref before it connects, so a secret pasted from another Supabase project is refused by name.

A secret reaches only the step that needs it, as that step's environment; it is never printed, written to an artifact or put on a command line (`pg_dump` and `psql` read libpq's environment). A pull request or a fork never sees any of it: the workflow runs on dispatch only, and an environment secret is read only after approval.

## A release

A Pilot release is one approved `release` run, and the API is released through it, never by CI's `main` run:

1. **main** — the job refuses any other ref (and the environment admits only `main`).
2. **The image** (with `deploy_api`) — `<package>:sha-<commit>`, which CI publishes for every commit on `main`, resolved to its digest, and its OCI `org.opencontainers.image.revision` label held to the commit. No image, no release.
3. **Journal check** — the Pilot's migration journal against `main`'s migrations (below). A refusal stops the release before anything is written.
4. **Backup** — every release, code-only ones too: the encrypted backup below, uploaded as `pilot-backup-<run>-<attempt>`. Any failure stops the release here.
5. **Migrate** — `pnpm db:migrate`: every pending migration in one transaction, behind the journal check under the migration lock. None pending is fine.
6. **Seed** (with `run_seed`) — `pnpm db:seed`, idempotent. A reviewed seed change reaches the Pilot this way and no other.
7. **Journal check and fingerprint** — the journal again, and the complete fingerprint of the Pilot against the committed `packages/db/migrations/meta/_fingerprint.txt`; the log names every line that differs.
8. **Deploy** (with `deploy_api`) — Render's deploy hook with `imgURL=<package>@sha256:<digest>`, the exact image of step 2; the deploy id is recorded. The hook's 200 is not a deployment.
9. **Proof** (with `deploy_api`) — for up to ten minutes, three consecutive observations ten seconds apart, each `GET /healthz` 200 naming the released commit in `build.commit` with a fresh clock that advances, and `GET /readyz` 200, both answering `Cache-Control: no-store`. An old build, a failure, a stale clock or a non-ready answer starts the count again; on timeout the release fails naming the commit, the digest and the last thing it saw.

**A database-only release** is `release` with `deploy_api` off: steps 1 and 3–7, recorded as such in the run's summary, with no image, hook or URL read. It proves the schema, not that matching API code is live: the first API release after one deploys a commit whose database expectations match the schema already applied. The adoption run that applies 0010–0012 is one.

### When a release fails

The run's summary and the failed step's log say where it stopped. Stopped at 1–4: nothing was written; fix the cause and dispatch again. Stopped at 5: the migrator's one transaction rolled back, so the Pilot is as the journal check found it; a migration a disposable database took and the Pilot refused is environmental — see *Correcting a migration* in `packages/db/migrations/README.md`. Stopped at 7 or later: the migrations are applied; a fingerprint difference is a finding to read before anything else is released (it names the objects), and a failed deploy or proof leaves the Pilot's schema at the new migrations with the previous API running, which is why a migration has to stay compatible with the API it replaces until the next deploy lands. A release is safe to dispatch again: an applied migration is not applied twice, and each attempt takes its own backup.

### A paused Supabase project

A Free Supabase project is paused after a week without activity. When a connection fails with the database unreachable, the scripts say so: the Free Supabase project may be paused; resume it in the dashboard (the paused Supabase project's Restore button) and re-run the workflow. The keep-alive of the hosting issue keeps the Pilot awake once it is deployed.

## Backups

`packages/db/scripts/pilot-backup.sh` takes six plain-SQL dumps — `wms-schema.sql`, `wms-data.sql`, `drizzle-schema.sql`, `drizzle-data.sql`, `pgboss-schema.sql`, `pgboss-data.sql` (pg-boss's only where it exists: before migration 0011 there is none) — with PostgreSQL client 17 from PGDG (it refuses another major, and a client older than the server), `--no-owner` with privileges kept. All six read one exported snapshot: a session holds a read-only transaction open for the whole backup and every `pg_dump` imports its snapshot, so the API and the worker keep running while a release backs up, and a transaction that spans `wms` and `pgboss` — the outbox relay stamps a row and enqueues its job in one — is in the backup whole or not at all. Beside them go `manifest.json` (the run, the commit, the UTC time, the server's and the client's versions, the database's identity, the schemas, the journal's rows, every dump's sha256, and the `powersync` publication's tables, which a schema dump cannot carry) and `fingerprint.txt`, the database's fingerprint as it was dumped. The lot is tarred, encrypted with age to `pilot-backup.pub`, and uploaded as the run's only backup artifact, `pilot-backup-<run>-<attempt>`, kept 30 days; the plaintext never leaves the runner and is deleted on every exit. The private key lives in the owner's password manager and as `PILOT_BACKUP_AGE_KEY`, nowhere else.

CI rehearses the whole round trip on every run (`pnpm --filter @waste/db rehearse-restore`, then every suite against the restored database), so a change that would break a restore fails the merge.

## A restore

A restore replaces the Pilot's `wms`, `drizzle` and `pgboss` schemas with a backup's. It never touches `auth` or any other schema, nor a role or its password.

1. **Suspend the Pilot's services** in Render (the API and the worker), so nothing restarts into a half-restored database.
2. **Find the backup**: the id of the run that took it — a `release`, or an earlier `restore`'s safety backup — from the run's URL (`…/actions/runs/<id>`). Its artifact must not have expired.
3. **Dispatch** `restore` with `source_run_id` and `services_suspended` on, and approve it.

The job: checks the source run is a dispatched run of this workflow on `main`; downloads its newest backup artifact, the download refusing one whose digest differs from the artifact store's (the package's checksum); takes a **safety backup** of the Pilot as it is, restorable later by this run's id — and stops on any failure but one: a database that has lost a schema a backup requires cannot be backed up whole, and the restore goes on without a safety backup, saying so; decrypts and verifies the backup — every file's sha256, the manifest's run and commit against the source run's, and its identity against this database; then the **write barrier**: refuses to close over a barrier already closed (while `wms_api` cannot log in, recording would record the closed state and a recovery from it would restore nothing: run `recover-logins` for the earlier run first), records `wms_api`'s and `wms_worker`'s LOGIN in `login-state.json` (no credential), stores it as the artifact `login-state-<run>-<attempt>` for 90 days, reads it back and checks its digest, and only then sets both roles NOLOGIN, ends their sessions and waits until none remain. One `psql` then drops the three schemas and restores the backup in a single transaction — the schemas, the publication's tables, the data — and any error rolls the whole of it back. The journal check and the backup's own fingerprint prove the result, only after every check do the recorded LOGIN states come back, and the run ends with the check's own report of the roles and the publication.

4. **Resume the services**, and run `check`.

The restored database is at the backup's journal position; a `release` brings it forward to `main`'s migrations.

**If a restore fails or is cancelled after the barrier closed, `wms_api` and `wms_worker` stay NOLOGIN** — the API answers 503 rather than writing into a database mid-restore. Read the failed step, then run `recover-logins` with that run's id.

## recover-logins

`recover-logins` takes the id of the restore (or reset) run that closed the barrier. It checks the run is a dispatched run of this workflow on `main`, downloads its newest login record, checks the record's shape, operation, run, commit and database, re-reads the roles, and restores only what the barrier took: a role recorded LOGIN that cannot log in now gets it back, a role already as recorded is left alone, and a role that can log in now but was recorded NOLOGIN is **refused**, since somebody changed it since and the record no longer says what is right. It reports the final state and never a credential.

**Break-glass, outside normal operation**: when the record has expired (after 90 days) or is lost and the roles are still NOLOGIN, `recover-logins` refuses. Run `check` first: it names each role's state. When you are sure no restore or reset is still running and the database is in the state you intend, run `grant-logins`, which gives both app roles LOGIN with the passwords the `pilot` environment holds — the ones Render runs with — and nothing else.

## grant-logins and rotation

`grant-logins` reads `PILOT_DATABASE_ADMIN_URL`, `PILOT_DATABASE_URL` and `PILOT_WORKER_DATABASE_URL`, holds each to the Pilot's pooler host, port 5432, the `postgres` database and its own user (`postgres.<ref>`, `wms_api.<ref>`, `wms_worker.<ref>`), masks every password in the log before anything runs, and grants LOGIN to exactly the two roles. It accepts no role name and no SQL.

- **The owner's password** (`postgres`): reset it in the dashboard (Database › Settings) whenever the connection string has been seen anywhere but the `pilot` environment and the password manager; copy the Session pooler string from the Connect dialog, percent-encode the password, add `?sslmode=require`, and replace `PILOT_DATABASE_ADMIN_URL` and the password manager's copy. The pooler may answer 28P01 for about a minute after a reset. A reset does not touch the app roles' logins.
- **The app roles' passwords**: generate new ones; store the new URLs as `PILOT_DATABASE_URL` and `PILOT_WORKER_DATABASE_URL` and in Render; run `grant-logins`; deploy the matching configuration; confirm `/readyz` answers with each least-privileged role; then delete any old copy.

## repair

When a merged migration meets data on the Pilot that it cannot take, the data is mended by a committed repair module and the release runs again; the procedure and the rules are in `packages/db/migrations/README.md` (*Correcting a migration*). Dispatch `repair` with the module's id, `<issue>-<slug>`, as `scripts/repairs/index.ts` lists it: the precondition, the apply and the postcondition run in one owner transaction under the migration lock; a repair already applied is verified and writes nothing; one whose data is in neither state is refused without writing.

## Adoption

The hand actions that brought the Pilot behind this door are Issue #152's slice 3: rotate the owner's password, create the `pilot` environment and its secrets, commit the age recipient, run `check`, then `release` with `deploy_api` and `run_seed` off to apply 0010–0012, and delete every local copy of an owner or app-role credential.
