# syntax=docker/dockerfile:1

# The worker's container image, the API's recipe (apps/api/Dockerfile) with
# the package name changed and one difference at the end, said below. Build
# it from the repository root, because the worker runs the TypeScript source
# of two workspace packages that live beside it:
#
#     docker build -f apps/worker/Dockerfile .
#
# Two stages. The first installs the worker's workspace closure with the pnpm
# the root manifest pins and lets `pnpm deploy` lay the package out as one
# self-contained directory: its source, its production dependencies, and the
# workspace packages it runs (@waste/contracts, @waste/db) copied in with
# their `src/`, since they ship source and there is nothing to compile (see
# the root CLAUDE.md, Workspace packages). The second stage is Node alone,
# running that directory as the unprivileged `node` user with tsx's loader in
# the one process (`node --import tsx`), so the signal a host sends lands on
# the worker's own shutdown in src/main.ts, which stops taking jobs, lets a
# handler in flight finish, and closes its pools. There is no --env-file,
# unlike the `start` script: a container's environment comes from its host.
#
# /app mirrors the repository root as far as the worker's tsconfig reaches:
# the package at /app/apps/worker and tsconfig.base.json two levels up, so
# its `"extends": "../../tsconfig.base.json"` resolves there as on a
# workstation and the image runs on the same compiler options.
#
# The worker reads HOST, PORT, WORKER_DATABASE_URL and DATABASE_URL
# (apps/worker/src/env.ts) and refuses to start without the last two. Unlike
# the API, it also refuses to start when the database does not answer or
# lacks pg-boss's schema: pg-boss checks the installed schema version before
# anything else, and a worker that cannot see its queues has nothing to do.
# So the process exits with the reason, and the host restarts it — a database
# that is down at boot is one the next start will find up — where the API
# stays up and answers 503. The probes bind after pg-boss started, so
# /healthz answers only for a worker that took its queues.

# Node 22, the major .nvmrc names, on Alpine. Nothing below is Alpine's own,
# so a Debian variant of the same major builds too.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo

# pnpm at the version `packageManager` pins, read from the manifest so the two
# cannot drift; the layer is keyed on package.json alone, which is all it
# reads. Installed with npm, which every Node image has: corepack is leaving
# Node's distribution (gone from Node 25).
COPY package.json ./
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"

# The lockfile, the workspace file and every workspace manifest, so
# --frozen-lockfile can hold the lockfile to the workspace as a whole, and
# then only the worker's closure is installed. Redone when a manifest or the
# lockfile changes, not when source does.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/tooling/package.json packages/tooling/
RUN pnpm install --frozen-lockfile --prod --filter @waste/worker...

# The worker and the packages it runs, deployed to the path the runtime stage
# keeps, so what pnpm writes into the shims under node_modules/.bin stays
# true. @waste/db depends on @waste/domain, so it is copied too. `pnpm deploy`
# resolves the same lockfile: the tarballs come from the store the install
# above filled, and only pnpm's supply-chain check goes back to the registry,
# for release metadata, which is why the step is not --offline. Each workspace
# package is copied in whole; .dockerignore keeps tests and reference data
# out.
COPY apps/worker apps/worker
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/domain packages/domain
RUN pnpm --filter @waste/worker deploy --prod /app/apps/worker
COPY tsconfig.base.json /app/tsconfig.base.json

# The tsconfig, `extends` included, read by tsx itself. Told which file to
# read (TSX_TSCONFIG_PATH), tsx refuses one it cannot resolve, naming the
# missing file, where a tsconfig it finds on its own it drops silently and
# runs with none. The refusal comes when the loader registers, before the
# --eval runs, so the line printing means the whole chain resolved. The
# runtime stage names the same file, so that holds at every start too.
WORKDIR /app/apps/worker
RUN TSX_TSCONFIG_PATH=tsconfig.json node --import tsx --eval "console.log('tsconfig.json read by tsx, tsconfig.base.json included')"

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3002 \
    TSX_TSCONFIG_PATH=/app/apps/worker/tsconfig.json
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/worker
USER node
EXPOSE 3002
# Liveness: the process answers. Readiness (pg-boss and the database answer,
# with the count of failed jobs) is GET /readyz, an operator's question, not
# the container's. Node's own fetch, so the probe asks nothing of the base
# image; shell form, so HOST and PORT are the ones in force at run time. The
# probe follows HOST: a wildcard (0.0.0.0, ::) is reached on loopback, an IPv6
# address is bracketed, and a specific address or name is probed as given.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const h = process.env.HOST || '127.0.0.1', host = h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h.includes(':') ? '[' + h + ']' : h; fetch('http://' + host + ':' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]
