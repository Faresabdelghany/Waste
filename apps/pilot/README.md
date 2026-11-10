# apps/pilot

The Pilot's container (Issue #149; the worker shape of #128, measured in #134; ADR-0008): the API and the worker as two child processes in one container under a small supervisor, built by Suga from `Dockerfile` on the deploy branch `pilot`. Nothing here is a Pilot value: the knobs and the pool ceilings the Pilot runs with are the Suga service's environment, listed below because no file in the repository carries them.

## What is here

- `src/supervise.ts` — the rules: the host's `PORT` to the API, loopback 3002 to the worker; each child's lines prefixed `[api]`, `[worker]`; the worker restarted with backoff, 5 s doubling to 5 min, reset after 10 min up, while the API keeps running; the container exiting with the API's code when the API exits; SIGTERM and SIGINT forwarded to both children and both waited for, a child still up after 20 s killed. `src/__tests__/supervise.test.ts` runs them over `node -e` children with small timings, and the backoff over scripted children on a clock it moves.
- `src/config.ts` — what `src/main.ts` composes from the environment: `PORT`, `HOST` (the API's), `WORKER_HOST`, `WORKER_PORT` (loopback 3002), `PILOT_API_DIR`, `PILOT_WORKER_DIR` (the image's deploy directories), `PILOT_MEMORY_LOG_SECONDS` (off unless set). Each child runs the bundle where the image built one, else the TypeScript source through tsx.
- `src/memory.ts` — the memory line gate 1 was read with: the cgroup's current, peak and limit beside each process's RSS and peak, and the container's byte counters.
- `src/bundle.ts` — the esbuild step: `pnpm --filter @waste/pilot bundle <app> <entry.ts> <outfile.mjs>` inlines an entry's workspace TypeScript and npm dependencies into one ESM file, Node's built-ins native.
- `Dockerfile` — both apps' closures through `pnpm deploy`, the three bundles, Supabase's root CA (`supabase-root-2021-ca.crt`) named by `NODE_EXTRA_CA_CERTS`, `build.json` from `SOURCE_COMMIT` (CI) or `release.json` (the deploy branch). Build from the repository root: `docker build -f apps/pilot/Dockerfile .`
- `release.json` — **never on `main`.** Every commit of the `pilot` branch carries it, written by the release (`src/release.ts`, the deploy phase of `src/operations.ts`): `{"commit":"<the released main commit>"}`, which the image turns into `build.json`, so `GET /healthz` on the Pilot names the released commit though Suga passes no commit into a build.
- `src/operations.ts` — the Pilot's six operations (`check`, `release`, `reset-to-seed`, `grant-logins`, `restore`, `recover-logins`), each the list of phases its job of `.github/workflows/pilot-database.yml` runs in order, one step each as `node --import tsx src/operate.ts <operation> <phase>`; `src/__tests__/operations.test.ts` holds the workflow to the lists. `src/operation.ts` is what an operation is: its name, its admission (main only where the Pilot is the target, `services_suspended`, `source_run_id`) and the command line. The database's phases, the write barrier and the context a phase gets (the Pilot-target check, the names of every file and artifact) are `@waste/db`'s `src/pilot/`; the phases here talk to GitHub or to the released Pilot: `src/release.ts` (the release order, CI's proof, the deploy, the live proof), `src/artifacts.ts` (which run a restore or a recovery reads from), both through `src/github.ts`, the one GitHub client. Nothing of these reaches the image.

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

   `HOST`, `WORKER_HOST`, `WORKER_PORT` and `NODE_EXTRA_CA_CERTS` are the image's own. The three secrets are the `pilot` environment's `PILOT_DATABASE_URL`, `PILOT_WORKER_DATABASE_URL` and the project's origin, and go nowhere else (`supabase/README.md`).
4. **The repository variable** `PILOT_API_URL`: the service's `https://<name>.suga.run`, which the release's proof reads.
5. **The first release**: the next merge to `main` once CI passes (ADR-0011: every merge releases itself, with no approval), or `release` dispatched with `deploy_api` on; the run's Deploy step writes `pilot`, Suga builds and rolls out, the proof passes once `/healthz` names the commit and `/readyz` answers 200 three times running. A push made with the workflow's own token starts no Actions run (nothing should run on `pilot`) but does fire the GitHub App webhooks Suga listens to; if Suga does not build within a minute of the Deploy step, the place to look is the app's webhook deliveries (Settings › GitHub Apps › Suga) and the service's build log. Then the two readings ADR-0008 owes (#149's acceptance): the memory line and Supabase's egress meter after a day, and the authenticated readings with a tester's token.

## The variables, as the code reads them

Each process declares what it reads, and the declaration is the one place a variable's meaning, its refusal and what its absence means are written: the API's in `apps/api/src/env.ts`, the worker's in `apps/worker/src/env.ts` (each held to its `turbo.json` dev task by the app's env test), and the supervisor's own in `src/config.ts` (`SUPERVISOR_VARIABLES`). Absent means the code's own default, so a workstation and CI run as before. The table under step 3 names only declared variables (`src/__tests__/environment.test.ts`).
