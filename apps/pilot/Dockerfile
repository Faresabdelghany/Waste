# syntax=docker/dockerfile:1

# The Pilot's container image (Issue #149; the worker shape of #128, measured
# in #134; ADR-0008): the API and the worker as two child processes in one
# container under the supervisor of apps/pilot. Suga builds it from this file
# on every push to the tracked `pilot` branch, with the repository root as
# the context; CI builds and smoke-tests it the same way, and pushes it
# nowhere:
#
#     docker build -f apps/pilot/Dockerfile .
#
# Two stages. The first installs the closures of the API, the worker and this
# package with the pnpm the root manifest pins, lets `pnpm deploy` lay each
# app out as its own image would (apps/api/Dockerfile, apps/worker/Dockerfile:
# the source, the production dependencies and the workspace packages it runs,
# each with its `src/`), and then bundles each app's entry with esbuild
# (src/bundle.ts) into one ESM file beside its source — src/server.mjs and
# src/main.mjs, so the API's ../build.json still resolves — and the
# supervisor's entry into /app/apps/pilot/main.mjs. The second stage is Node
# alone, running the supervisor's bundle as the unprivileged `node` user; the
# supervisor runs each app's bundle with plain node in its deploy directory.
# No tsx loads at boot: at a tenth of a core tsx took 100–145 s to boot both
# apps, where the bundles take 13–18 s (#134, gate 1). Each app's deploy
# directory keeps its node_modules, so anything a dependency requires at run
# time outside the bundle still resolves; only the bundles are run.
#
# Only the API's port is exposed; the worker's probes stay on loopback inside
# the container, and its health is the supervisor's restart lines in the log.
#
# The API reads HOST, PORT, DATABASE_URL, SUPABASE_URL and DATABASE_POOL_MAX;
# the worker reads WORKER_DATABASE_URL, DATABASE_URL and its knobs
# (apps/worker/src/env.ts), its HOST and PORT set by the supervisor from
# WORKER_HOST and WORKER_PORT. The host sets PORT and the secrets; the Pilot's
# knobs are its environment too, never a default here (README.md lists them).

# Node 22, the major .nvmrc names, on Alpine. Nothing below is Alpine's own,
# so a Debian variant of the same major builds too.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo

# pnpm at the version `packageManager` pins, read from the manifest so the two
# cannot drift; installed with npm, which every Node image has.
COPY package.json ./
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"

# The lockfile, the workspace file and every workspace manifest, so
# --frozen-lockfile can hold the lockfile to the workspace as a whole, and
# then the three closures are installed. Redone when a manifest or the
# lockfile changes, not when source does. This package's dependencies are
# esbuild and tsx, the bundle step's, which is why they are dependencies and
# not devDependencies: --prod installs them here, and nothing of this package
# but its bundle reaches the runtime stage.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/pilot/package.json apps/pilot/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/routing/package.json packages/routing/
COPY packages/tooling/package.json packages/tooling/
RUN pnpm install --frozen-lockfile --prod --filter @waste/api... --filter @waste/worker... --filter @waste/pilot...

# The two apps and the packages they run; .dockerignore keeps tests and
# reference data out. Each app is deployed to the path the runtime stage
# keeps, and tsconfig.base.json sits two levels above each, so every
# `"extends": "../../tsconfig.base.json"` resolves there as on a workstation.
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/domain packages/domain
COPY packages/routing packages/routing
COPY tsconfig.base.json ./
RUN pnpm --filter @waste/api deploy --prod /app/apps/api \
 && pnpm --filter @waste/worker deploy --prod /app/apps/worker
COPY tsconfig.base.json /app/tsconfig.base.json

# This package after the deploys, since every release commit changes its
# release.json and nothing of it reaches either deploy: the two layers above
# survive a release whose app source did not change.
COPY apps/pilot apps/pilot

# The bundles: each entry resolved from its own app in the installed
# workspace, with the app's tsconfig, written beside the deployed source.
RUN pnpm --filter @waste/pilot bundle api server.ts /app/apps/api/src/server.mjs \
 && pnpm --filter @waste/pilot bundle worker main.ts /app/apps/worker/src/main.mjs \
 && pnpm --filter @waste/pilot bundle pilot main.ts /app/apps/pilot/main.mjs
# The release file, where the commit being built carries one: every commit
# of the deploy branch does (packages/db/src/pilot/release.ts writes it),
# main never does. Kept beside the supervisor for the runtime stage below.
RUN if [ -f apps/pilot/release.json ]; then cp apps/pilot/release.json /app/apps/pilot/release.json; fi

# Supabase's root CA, as its dashboard publishes it (prod-ca-2021.crt: the
# root the session pooler's chain ends in; certificate SHA-256 fingerprint
# 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA,
# valid to 2031-04-26). node-postgres, which pg-boss dials through, reads
# `sslmode=require` as verify-full and refused the pooler's chain as
# self-signed until this root was trusted (#134); NODE_EXTRA_CA_CERTS below
# names it, so both drivers verify the pooler against Supabase's root.
COPY apps/pilot/supabase-root-2021-ca.crt /app/supabase-root-2021-ca.crt

FROM ${NODE_IMAGE} AS runtime
# HOST and PORT are the API's; WORKER_HOST and WORKER_PORT the worker's, on
# loopback. The host's PORT wins over the image's.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    WORKER_HOST=127.0.0.1 \
    WORKER_PORT=3002 \
    NODE_EXTRA_CA_CERTS=/app/supabase-root-2021-ca.crt
COPY --from=build --chown=node:node /app /app
# The commit the image is built from (Issue #152): build.json beside the
# API's package.json, which its GET /healthz reads as build.commit — what a
# Pilot release proves live — and, where the build argument is given, the OCI
# revision label as apps/api/Dockerfile carries it. Two sources, the file
# first: on the deploy branch apps/pilot/release.json names the released
# commit of main — the release wrote it into the branch's tree
# (packages/db/src/pilot/release.ts) and the build stage kept it above — and
# that is what /healthz must name, whoever builds the commit; Suga passes no
# commit into a build anyway (its build arguments are values typed into the
# service's form), so there the label stays empty and the file is the truth.
# Without the file, the argument: CI passes SOURCE_COMMIT for main's commits.
# Neither on a local build from main, and /healthz names no build; anything
# but a full lowercase commit id fails the build.
ARG SOURCE_COMMIT=""
LABEL org.opencontainers.image.revision="${SOURCE_COMMIT}"
RUN commit="$SOURCE_COMMIT"; \
    if [ -f /app/apps/pilot/release.json ]; then \
      commit="$(node -p "JSON.parse(require('fs').readFileSync('/app/apps/pilot/release.json', 'utf8')).commit")"; \
    fi; \
    if [ -n "$commit" ]; then \
      printf "%s" "$commit" | grep -Eqx "[0-9a-f]{40}" \
        || { echo "the commit is not a full commit id: $commit" >&2; exit 1; }; \
      printf "{\"commit\":\"%s\"}\n" "$commit" > /app/apps/api/build.json \
        && chown node:node /app/apps/api/build.json; \
    fi
WORKDIR /app/apps/pilot
USER node
EXPOSE 3001
# Liveness of the API, the container's one public process; readiness (the
# database answers) is GET /readyz, the balancer's question, and the worker's
# health is the supervisor's restart lines in the log (#128, Q9). Shell form,
# so PORT is the one in force at run time.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "main.mjs"]
