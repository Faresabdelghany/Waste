# apps/pilot

The Pilot's container (Issue #149; the worker shape of #128, measured in #134; ADR-0008): the API and the worker as two child processes in one container under a small supervisor, built by Suga from `Dockerfile` on the deploy branch `pilot`. Nothing here is a Pilot value: the knobs and the pool ceilings the Pilot runs with are the Suga service's environment, listed below because no file in the repository carries them.

## What is here

- `src/supervise.ts` — the rules: the host's `PORT` to the API, loopback 3002 to the worker; each child's lines prefixed `[api]`, `[worker]`; the worker restarted with backoff, 5 s doubling to 5 min, reset after 10 min up, while the API keeps running; the container exiting with the API's code when the API exits; SIGTERM and SIGINT forwarded to both children and both waited for, a child still up after 20 s killed. `src/__tests__/supervise.test.ts` runs them over `node -e` children with small timings.
- `src/config.ts` — what `src/main.ts` composes from the environment: `PORT`, `HOST` (the API's), `WORKER_HOST`, `WORKER_PORT` (loopback 3002), `PILOT_API_DIR`, `PILOT_WORKER_DIR` (the image's deploy directories), `PILOT_MEMORY_LOG_SECONDS` (off unless set). Each child runs the bundle where the image built one, else the TypeScript source through tsx.
- `src/memory.ts` — the memory line gate 1 was read with: the cgroup's current, peak and limit beside each process's RSS and peak, and the container's byte counters.
- `src/bundle.ts` — the esbuild step: `pnpm --filter @waste/pilot bundle <app> <entry.ts> <outfile.mjs>` inlines an entry's workspace TypeScript and npm dependencies into one ESM file, Node's built-ins native.
- `Dockerfile` — both apps' closures through `pnpm deploy`, the three bundles, Supabase's root CA (`supabase-root-2021-ca.crt`) named by `NODE_EXTRA_CA_CERTS`, `build.json` from `SOURCE_COMMIT` (CI) or `release.json` (the deploy branch). Build from the repository root: `docker build -f apps/pilot/Dockerfile .`
- `release.json` — **never on `main`.** Every commit of the `pilot` branch carries it, written by the release (`packages/db/src/pilot/release.ts`): `{"commit":"<the released main commit>"}`, which the image turns into `build.json`, so `GET /healthz` on the Pilot names the released commit though Suga passes no commit into a build.

## Running it

- **Tests, typecheck, lint**: `pnpm --filter @waste/pilot test` (and `typecheck`, `lint`), in the turbo gates with every other package.
- **The image, locally**: `docker build -f apps/pilot/Dockerfile -t waste-pilot:local .`, then the smoke test CI's `pilot-image` job runs — against a database nobody answers on (`DATABASE_URL=postgresql://wms_api:x@127.0.0.1:1/postgres`, the worker's the same, `SUPABASE_URL=https://example.supabase.co`): `GET /healthz` 200, `GET /readyz` 503, `[pilot] worker exited … restarting in 5 s` in the log, `docker stop` exit 0. Against the local stack (`pnpm stack:start`), point the URLs at `host.docker.internal` and the stack's ports; both `/readyz` answer 200, the worker's from inside the container on 3002.
- **On a workstation without Docker**: from the repository root, with the root `.env` exported, `PILOT_API_DIR=$PWD/apps/api PILOT_WORKER_DIR=$PWD/apps/worker PORT=3101 pnpm --filter @waste/pilot exec node --import tsx src/main.ts`; the children run their TypeScript through tsx, and Ctrl-C reaches the supervisor, which stops both.

## The Pilot's Suga service — the owner's hand steps

Only the account holder can do these (tracking issue #191 lists them). The values are variant C of #134, the ones ADR-0008 records.

1. **The branch.** `pilot` is created by the first `release` — the automatic one after CI on a push to `main`, or Actions › Pilot database › `release`, `deploy_api` on — or by hand from `main` in GitHub's branch view if Suga's form needs a branch to exist before the service can be saved. Nothing else moves it; a commit pushed to it by hand is built and served until the next release, whose tree is `main`'s whatever the branch held. If `pilot` is protected by a ruleset, grant the workflow a bypass (or add a deploy key), or the release's Deploy step is refused with a 403.
2. **The service.** In Suga, a web service from this repository (the GitHub app read-only on it): branch `pilot`, Dockerfile path `apps/pilot/Dockerfile`, build context `.`, no target stage, no build arguments, the public port the API's (`PORT`, which Suga sets).
3. **The environment**, in the service's dashboard:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the session pooler as `wms_api.<ref>` (port 5432, `?sslmode=require`), from the password manager |
   | `WORKER_DATABASE_URL` | the session pooler as `wms_worker.<ref>`, the same shape |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `DATABASE_POOL_MAX` | `5` |
   | `WORKER_API_POOL_MAX` | `3` |
   | `WORKER_POOL_MAX` | `2` |
   | `WORKER_POLLING_INTERVAL_SECONDS` | `30` |
   | `WORKER_SUPERVISE_INTERVAL_SECONDS` | `300` |
   | `WORKER_QUEUE_CACHE_INTERVAL_SECONDS` | `300` |
   | `WORKER_BOSS_IDLE_TIMEOUT_SECONDS` | `600` (or `0` for never) |
   | `PILOT_MEMORY_LOG_SECONDS` | `600` while the first week's readings are taken; unset after |
   | `ROUTING_PROVIDER` | `openrouteservice`, set together with the key once the OpenRouteService account exists (#171); unset until then, which is the fake |
   | `MESSAGING_PROVIDER` | unset, which is the log-only sender: every message is written to the log masked and marked sent, and nothing reaches anyone (#291 C15, the owner's decision on #291). No other value exists until a card-free provider is verified; any other name stops the worker's start |
   | `OPENROUTESERVICE_API_KEY` | the account's key, from the password manager; the worker's jobs and the API's guided-setup preview (#173) call the provider with it, and with the provider named and no key each refuses to start |
   | `ADDRESS_PROVIDER` | `dataforsyningen`, set together with the token once the owner has it (#77, #291 C13); unset until then, which is address lookup off: the lookup answers 503, the property forms' picker says so, and addresses are typed with the point placed by hand. Never `fake` here: its made-up addresses would be written on real properties |
   | `DATAFORSYNINGEN_TOKEN` | the owner's Dataforsyningen token, from the password manager; the API's address lookup calls the register with it, and with the register named and no token the API refuses to start. Server-side only, never the web's |
   | `ROUTING_PREVIEW_CALLS_PER_MINUTE` | unset, the API's 10; with the worker's `ROUTING_CALLS_PER_MINUTE` (unset, 30) the Standard plan's 40 a minute, so a change to one is a change to the other (#173) |
   | `PUBLIC_TRUSTED_PROXIES` | `1` once Suga's proxy is known to append exactly one `X-Forwarded-For` entry (ADR-0010); until then unset, and every public reader counts as Suga's proxy, one allowance for all |
   | `SUPABASE_SERVICE_ROLE_KEY` | the project's service-role key, from the dashboard's API settings, into the password manager; the API signs proof photos' and signatures' uploads and reads with it and the worker's purge removes old ones (O1 of #290). Server-side only, never the web's; unset, the photo routes answer 503 and nothing is purged |
   | `PROOF_RETENTION_DAYS` | `90`: a photo or a signature older than this leaves Storage at the nightly purge, unless an open ticket names its stop |
   | `POSITION_RETENTION_DAYS` | `30`: a position the Driver App recorded older than this is deleted at the nightly purge (O8 of #290); personal location data (#381), so never more than 30 |
   | `WORKER_RULES_INTERVAL_SECONDS` | `300`: the alert rules look for a route not started, a silent device, a licence running out, an overdue ticket and a stale position every five minutes (O4 and O8 of #290) |

   `HOST`, `WORKER_HOST`, `WORKER_PORT` and `NODE_EXTRA_CA_CERTS` are the image's own. The three secrets are the `pilot` environment's `PILOT_DATABASE_URL`, `PILOT_WORKER_DATABASE_URL` and the project's origin, and go nowhere else (`supabase/README.md`).
4. **The repository variable** `PILOT_API_URL`: the service's `https://<name>.suga.run`, which the release's proof reads.
5. **The first release**: the next merge to `main` once CI passes (ADR-0011: every merge releases itself, with no approval), or `release` dispatched with `deploy_api` on; the run's Deploy step writes `pilot`, Suga builds and rolls out, the proof passes once `/healthz` names the commit and `/readyz` answers 200 three times running. A push made with the workflow's own token starts no Actions run (nothing should run on `pilot`) but does fire the GitHub App webhooks Suga listens to; if Suga does not build within a minute of the Deploy step, the place to look is the app's webhook deliveries (Settings › GitHub Apps › Suga) and the service's build log. Then the two readings ADR-0008 owes (#149's acceptance): the memory line and Supabase's egress meter after a day, and the authenticated readings with a tester's token.

## The knobs, as the code reads them

Each is read once in the app's `env.ts` and applied in one place; absent means the code's own default, so a workstation and CI run as before.

| Variable | Reads it | Absent | Effect |
|---|---|---|---|
| `DATABASE_POOL_MAX` | the API | postgres.js's 10 | the request pool's size (`apps/api/src/server.ts`) |
| `WORKER_API_POOL_MAX`, `WORKER_POOL_MAX` | the worker | 10 each | the API-role and worker-role pools' sizes (`apps/worker/src/main.ts`); pg-boss's own pool stays at 3 |
| `WORKER_POLLING_INTERVAL_SECONDS` | the worker | pg-boss's and the jobs' own | every queue's poll, the relay's successor delay and pg-boss's cron and flow intervals raised to it, never lowered, the cron two capped at pg-boss's 45 (`apps/worker/src/boss.ts`); no `schedule` cron is touched |
| `WORKER_SUPERVISE_INTERVAL_SECONDS` | the worker | pg-boss's 60 | pg-boss's supervise pass and, with it, the monitor pass that refreshes the counts `/readyz` reads |
| `WORKER_QUEUE_CACHE_INTERVAL_SECONDS` | the worker | pg-boss's 60 | pg-boss's queue-cache refresh |
| `WORKER_BOSS_IDLE_TIMEOUT_SECONDS` | the worker | pg-pool's 10 | how long pg-boss's pool keeps an idle connection; 0 for never |
| `PILOT_MEMORY_LOG_SECONDS` | the supervisor | off | the memory line's period |
| `ROUTING_DIRECTIONS_RESERVE`, `ROUTING_OPTIMISATION_RESERVE` | the worker | the Standard plan's 500 and 100 | where batch routing work stops, per family, leaving the rest of the day's quota to the office's own calls (`@waste/routing/quota`, #132 §1) |
| `ROUTING_CALLS_PER_MINUTE` | the worker | 30 | each routing family's calls a minute from the worker's jobs |
| `ROUTING_PREVIEW_CALLS_PER_MINUTE` | the API | 10 | each routing family's calls a minute from the guided setup's preview (#173), which never waits for the minute and answers the estimate instead |
| `PUBLIC_REQUESTS_PER_MINUTE` | the API | 60 | each public client's requests a minute on the public door (ADR-0010) |
| `PUBLIC_TRUSTED_PROXIES` | the API | 0 | how many proxies in front append to `X-Forwarded-For`; 0 ignores the header and counts the socket's peer (`apps/api/src/auth/public-door.ts`) |
| `SUPABASE_SERVICE_ROLE_KEY` | the API and the worker | no Storage | the API signs a proof's upload and its read URLs (`@waste/db/storage`), and without it `POST /driver/uploads` and `GET /pickups/:id/proof-objects` answer 503; the worker's purge removes nothing |
| `PROOF_RETENTION_DAYS` | the worker | no purge | how many days a photo or a signature is kept before the nightly purge (`apps/worker/src/jobs/purge-proof-objects.ts`) removes it from Storage, unless an open ticket names its stop; a project whose privacy policy names days of its own (Settings › Privacy, #291 C19) is held to those instead |
| `POSITION_RETENTION_DAYS` | the worker | 30, the ceiling | how many days a position is kept before the nightly purge (`apps/worker/src/jobs/purge-positions.ts`) deletes it; at most 30 (`POSITION_RETENTION_CEILING_DAYS`, `@waste/domain/execution/positions`), anything more refused at start, and unset is the ceiling, since a track kept by omission is what the ceiling rules out; a project whose privacy policy names days of its own (#291 C19) is held to those, under the same ceiling |
| `WORKER_RULES_INTERVAL_SECONDS` | the worker | 300 | how often the alert rules (`apps/worker/src/jobs/alert-rules.ts`, O4 of #290) look for a route not started, a silent device, a licence running out, an overdue ticket and a stale position: whole minutes that divide an hour or whole hours that divide a day (`apps/worker/src/cadence.ts`), anything else refused at start; a quiet tick reads six empty results |

The two defaults sum to the Standard plan's 40 calls a minute on the one key both processes call with, so raising one means lowering the other.
