---
status: deferred
date: 2026-09-25
---

# Hosting the API, the worker and Valhalla

*Deferred 2026-09-30: the Pilot runs the API and the worker as one Suga Free service under a supervisor (ADR-0008), and this two-host target returns with Gate B, its budget and its Valhalla.*

Three workloads need a host outside Supabase, and the architecture doc has held the choice open between Fly.io and Railway. The API ships as a container image today (`apps/api/Dockerfile`, built from the repository root and smoke-tested on every CI run, pushed nowhere). The pg-boss worker will be a second Node process on the same Postgres through the session pooler, and the PowerSync service, if it is self-hosted rather than run in PowerSync's EU cloud, a third long-running process on a logical replication slot. Valhalla is a routing engine over Denmark's tiles: a persistent volume of a few gigabytes that outlives a redeploy, since the tiles take a good while to build from the 470 MB extract, and a few gigabytes of memory while it serves matrices to the optimiser and legs to the map. The database is in Supabase's `eu-north-1`, Stockholm, and the API opens a transaction per authenticated request that spends several round trips on the principal alone — the tenant setting, the account, its role and grants, its projects, its provider — before the handler's own statements, so every millisecond between the host and the database is paid several times per request.

What was weighed: the region against the database; persistent volumes; private networking between the three; what a platform's health check means — `GET /readyz` answers 503 while the database is unreachable, and that is readiness, a reason to route around the process and never a reason to restart it, where `GET /healthz` is liveness, the process answering; graceful shutdown, since `apps/api/src/server.ts` drains requests in flight on SIGTERM for up to 5 s (`SHUTDOWN_GRACE_MS`) and then closes its pools; how secrets reach the process; what a development API that nobody calls for days costs; and whether the platform runs the image CI already builds or rebuilds it from the Dockerfile.

We decided on Fly.io, for three reasons. Fly has a Stockholm region, `arn`, beside Supabase's `eu-north-1`, where Railway's European region is Amsterdam, and the per-request transaction turns that distance into tens of milliseconds on every call. Fly runs each workload as a Machine described by a file committed beside its source, and that file carries what the API's process needs from its host — the signal (`kill_signal = "SIGTERM"`), a grace over the API's own (`kill_timeout`), a check on `/healthz` alone, and a stop-when-idle policy that makes a development API cost about nothing between calls — where on Railway the region, the drain window and the volume are service settings held by the dashboard. And Fly Volumes attach to a Machine in the same region at the size Valhalla's tiles need, on Machines with the memory it needs, on the organisation's private network (6PN, `<app>.internal`), which the API and the worker reach it over without a public address.

The API's configuration is `apps/api/fly.toml`. It lives beside the Dockerfile, and `fly deploy` runs from the repository root with `--config apps/api/fly.toml`, because the working directory is the build context and the Dockerfile copies the workspace manifests and three sibling packages from the root — the same context CI builds with (`docker build -f apps/api/Dockerfile .`), so the root `.dockerignore` applies unchanged and no `apps/api/.dockerignore` is added. Its `[build] dockerfile = "Dockerfile"` is a path relative to the file. The check is `GET /healthz`: Fly's check decides whether a Machine receives traffic and whether a deploy is judged healthy, so a check on `/readyz` would fail a deploy while the database is down and pull the one Machine out of routing exactly when the API's own 503 body is what a client should read; the Dockerfile's `HEALTHCHECK` makes the same split. `DATABASE_URL` and `SUPABASE_URL` are secrets, set with `fly secrets set` and never written into the file. `DATABASE_URL` is the session pooler — port 5432 on `aws-0-eu-north-1.pooler.supabase.com`, the user `wms_api.<project-ref>` — and not the transaction pooler on 6543: the migrator refuses that port by name (`packages/db/src/migrate.ts`; its advisory lock needs one backend for the whole run), pg-boss needs a session too, and the client sends `search_path` as a startup parameter the pooler forwards only in session mode. The API's own transactions would survive transaction mode — `withCompany` sets the tenant transaction-locally and the client runs with `prepare: false` — but one URL shape for the API, the worker and the migrator is the rule, and the direct host `db.<project-ref>.supabase.co` is IPv6-only without Supabase's IPv4 add-on.

## Applying it

One login and four commands, from the repository root, with `flyctl` installed. The app name is global on `fly.dev`; if `waste-api-dev` is taken, change `app` in the file and `--app` below.

```
fly auth login
(cd apps/api && fly launch --no-deploy --copy-config --yes)
fly secrets set --app waste-api-dev \
  DATABASE_URL='postgresql://wms_api.<project-ref>:<password>@aws-0-eu-north-1.pooler.supabase.com:5432/postgres' \
  SUPABASE_URL='https://<project-ref>.supabase.co'
fly deploy --config apps/api/fly.toml
```

`fly launch --copy-config` creates the app under the name and region the file carries and deploys nothing; `--yes` skips the prompt to tweak the settings. It rewrites the file in its own spelling, so a diff of `apps/api/fly.toml` afterwards should show formatting alone; commit or discard it. Secrets on an app with no Machine are staged and land with the first deploy; on a running app, `fly secrets set` restarts the Machine with the new value. `fly deploy` builds on Fly's remote builder from the Dockerfile and starts one Machine in `arn`. Then `curl https://waste-api-dev.fly.dev/healthz` answers 200, and `/readyz` answers `{"status":"ok","checks":{"database":"ok"}}` when the pooler URL is right and a 503 naming the database unreachable when it is not — the two answers CI's smoke test already pins.

## Considered options

- **Railway.** The same Dockerfile builds there (root directory `/`, `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile`), a service can be deployed from an image, private networking is `<service>.railway.internal`, a service takes one volume, and `railway.json` carries build and deploy settings, a health-check path among them. Rejected for the region — Amsterdam is the nearest, on the order of 15–20 ms from Stockholm each way, against a request path of several statements — and for how much of the host stays outside the repository: the region, the volume and the drain window are service settings, the health-check path gates a deployment rather than routing (to verify), and the default window between SIGTERM and SIGKILL is short (3 s by its docs, to verify), under the API's 5 s drain unless `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` is raised. Its per-second billing and app sleeping would make a development API as cheap. The platform is fine; the region is not.
- **Deploying the CI-built image instead of rebuilding.** `fly deploy --image` takes an image from a registry, so a CI step can push to `registry.fly.io/<app>` and deploy that digest. Not now: nothing pushes an image yet (`ci.yml` builds with `push: false`), and a remote build from the same Dockerfile and context is enough for a development app.
- **A virtual server (Hetzner, one Docker Compose file).** The cheapest fixed cost for Valhalla's memory and disk; patching, TLS, restarts and the disk are ours. Kept as the fallback for Valhalla alone if a Fly Machine of its size costs more than the server would.
- **Supabase Edge Functions, Vercel.** Neither runs a long-lived process: the worker polls and the API holds a pool.

## Consequences

- The worker and, if self-hosted, PowerSync are each a Fly app with a `fly.toml` of their own, on the same organisation's 6PN, reaching the database over the session pooler and each other by `<app>.internal`. The worker's is `apps/worker/fly.toml` (2026-09-25): no `[http_service]`, since it exposes no public address, a top-level `[checks]` on `GET /healthz` at its internal port 3002 — the same liveness-only split as the API's, since its `/readyz` answers 503 while the database is unreachable and pg-boss reconnects on its next poll — a `[[restart]]` policy of `always`, since the worker exits rather than idles when its database does not answer at boot or lacks pg-boss's schema, and a `kill_timeout` of 20 s over its 10 s handler grace and the pools' 5 s end; `WORKER_DATABASE_URL` and `DATABASE_URL` are its secrets, both the session pooler. PowerSync's `wms_sync` role and publication are migration 0008's; the worker's `wms_worker` role and pg-boss's schema are migration 0011's.
- Valhalla is a Fly app with a `[mounts]` volume in `arn` for the tiles, a Machine of a few gigabytes of memory, and no public address: the API and the worker call `valhalla.internal`. The tiles are built once onto the volume and rebuilt when the extract is refreshed; a Fly Volume is a single-host device, and beyond Fly's snapshots it is not backed up, which tiles that can be rebuilt do not need.
- CI keeps building and smoke-testing the image without pushing it. The day a deploy from CI is wanted, a step pushes to `registry.fly.io` and runs `fly deploy --image` with a deploy token; the Dockerfile's and `ci.yml`'s comments saying the host is undecided are corrected then.
- A development API stops when idle (`auto_stop_machines = "stop"`, `min_machines_running = 0`): a stopped Machine bills its root filesystem and nothing else, and the first request after a stop waits for the start and tsx's module load, a couple of seconds. A production app sets `min_machines_running = 1` and runs two Machines for a deploy with no gap.
- The web app on Vercel calls the API at its `fly.dev` hostname, later a custom domain through `fly certs`; nothing in `apps/web` changes for this decision.

## To verify on the first deploy

The claims about the platforms come from their public docs and were not fetched by the session that wrote this.

- `[build] dockerfile` resolves relative to the fly.toml. If flyctl reports the Dockerfile missing, pass `--dockerfile apps/api/Dockerfile` (the flag wins over the file) and change the file's value to that path.
- flyctl reads `.dockerignore` from the context root and sends the Dockerfile even when that file excludes it, as `docker build` does; if the remote build cannot see the Dockerfile, drop the `apps/api/Dockerfile` line from the root `.dockerignore`.
- A failing `[[http_service.checks]]` check stops routing to the Machine and holds a deploy, and does not restart a running Machine.
- The Machine reaches the pooler host over Fly's IPv4 egress; the direct host over Fly's IPv6, should it ever be wanted.
- Current prices — `shared-cpu-1x` at 512 MB, a stopped Machine's root filesystem, a Volume per GB-month — and the Machine sizes Valhalla's Denmark tiles need.
- The Railway facts above: the default drain window, and whether its health check runs past deploy time.

## Sources (public docs, to confirm on first deploy)

- fly.toml reference: https://fly.io/docs/reference/configuration/
- Fly regions (`arn`): https://fly.io/docs/reference/regions/
- Fly monorepo deploys and the build context: https://fly.io/docs/launch/monorepo/
- Fly Volumes: https://fly.io/docs/volumes/overview/
- Fly private networking: https://fly.io/docs/networking/private-networking/
- Fly autostop and autostart: https://fly.io/docs/launch/autostop-autostart/
- Fly secrets: https://fly.io/docs/apps/secrets/
- Fly pricing: https://fly.io/docs/about/pricing/
- Railway regions: https://docs.railway.com/reference/regions
- Railway volumes: https://docs.railway.com/reference/volumes
- Railway private networking: https://docs.railway.com/reference/private-networking
- Railway health checks: https://docs.railway.com/reference/healthchecks
- Railway config as code: https://docs.railway.com/reference/config-as-code
- Supabase connection pooler modes: https://supabase.com/docs/guides/database/connecting-to-postgres
