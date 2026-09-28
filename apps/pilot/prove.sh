#!/usr/bin/env bash
# PROTOTYPE — throwaway (#134). The local proofs of the Pilot image, none of
# them needing the hosted database, a published image or Render:
#
#   A. a database nobody answers on: the API answers /healthz 200 and /readyz
#      503, the worker child exits and is restarted with 5 s then 10 s
#      backoff, `docker stop` ends the container cleanly with exit 0;
#   B. the local Supabase stack (pnpm db:start, migrated and bootstrapped):
#      both processes up, the API's /readyz 200 and the worker's internal
#      /readyz 200, RSS per process idle and after a burst of requests,
#      a clean stop.
#
# Prints the measurements; nothing is asserted beyond the status codes, since
# the point is to read the numbers. Run from anywhere:
#
#     apps/pilot/prove.sh            # both proofs
#     apps/pilot/prove.sh A          # one of them
#
# Reads DATABASE_URL, WORKER_DATABASE_URL and SUPABASE_URL for proof B from
# the repository's .env, pointing the loopback host at host.docker.internal.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE=waste-pilot:proto
PORT=3101
which="${1:-AB}"

ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
cleanup() { docker rm -f pilot-a pilot-b >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
status() { curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$PORT$1" || echo 000; }
body() { curl --silent "http://127.0.0.1:$PORT$1" || true; }
wait_for() { # container path code seconds
  for _ in $(seq 1 "$4"); do
    if [ "$(docker inspect --format '{{.State.Running}}' "$1")" != true ]; then echo "container $1 stopped early"; docker logs "$1"; return 1; fi
    [ "$(status "$2")" = "$3" ] && return 0
    sleep 1
  done
  echo "timed out waiting for $2 -> $3 (last $(status "$2"))"; return 1
}
rss() { # per-process VmRSS inside the container, then the cgroup figure
  echo "-- processes (VmRSS kB, command)"
  docker exec "$1" sh -c 'for p in /proc/[0-9]*; do r=$(sed -n "s/^VmRSS:[[:space:]]*//p" $p/status 2>/dev/null); [ -n "$r" ] || continue; c=$(tr "\0" " " < $p/cmdline | cut -c1-70); echo "  $r  $c"; done'
  echo "-- cgroup: $(docker stats --no-stream --format '{{.MemUsage}} ({{.MemPerc}})' "$1")"
}
stop_clean() { # name
  local t0 t1 code
  t0=$(date +%s)
  docker stop --time 30 "$1" >/dev/null
  t1=$(date +%s)
  code=$(docker inspect --format '{{.State.ExitCode}}' "$1")
  echo "-- docker stop took $((t1 - t0)) s, exit code $code"
  docker logs "$1" 2>&1 | grep -E '^\[pilot\]' | tail -6
}

echo "== build"
docker build --quiet -f apps/pilot/Dockerfile -t "$IMAGE" . >/dev/null
echo "-- image size: $(docker image inspect --format '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1024/1024}')"

if [[ "$which" == *A* ]]; then
  echo
  echo "== Proof A: a database nobody answers on"
  docker run --detach --name pilot-a --publish "$PORT:3001" --memory 512m \
    --env DATABASE_URL=postgresql://wms_api:x@127.0.0.1:1/postgres \
    --env WORKER_DATABASE_URL=postgresql://wms_worker:x@127.0.0.1:1/postgres \
    --env SUPABASE_URL=https://example.supabase.co \
    "$IMAGE" >/dev/null
  t0=$(ms)
  wait_for pilot-a /healthz 200 40
  t1=$(ms)
  echo "-- /healthz 200 after $((t1 - t0)) ms from docker run; /readyz -> $(status /readyz) $(body /readyz)"
  echo "-- waiting 17 s for two worker restarts (5 s, then 10 s)"
  sleep 17
  docker logs pilot-a 2>&1 | grep -E '^\[pilot\]'
  rss pilot-a
  stop_clean pilot-a
fi

if [[ "$which" == *B* ]]; then
  echo
  echo "== Proof B: the local Supabase stack"
  set -a; . ./.env; set +a
  to_docker() { echo "$1" | sed -E 's#@(127\.0\.0\.1|localhost):#@host.docker.internal:#'; }
  docker run --detach --name pilot-b --publish "$PORT:3001" --memory 512m \
    --env DATABASE_URL="$(to_docker "$DATABASE_URL")" \
    --env WORKER_DATABASE_URL="$(to_docker "$WORKER_DATABASE_URL")" \
    --env SUPABASE_URL="$SUPABASE_URL" \
    "$IMAGE" >/dev/null
  t0=$(ms)
  wait_for pilot-b /readyz 200 60
  t1=$(ms)
  echo "-- API /readyz 200 after $((t1 - t0)) ms from docker run"
  for _ in $(seq 1 30); do
    w=$(docker exec pilot-b node -e "fetch('http://127.0.0.1:3002/readyz').then(r => r.text().then(t => console.log(r.status, t)), e => console.log('000', e.message))")
    [[ "$w" == 200* ]] && break; sleep 1
  done
  echo "-- worker /readyz (inside the container): $w"
  echo "-- idle after 20 s"; sleep 20
  rss pilot-b
  echo "-- burst: 300 × GET /openapi.json and 300 × GET /readyz, 10 at a time"
  tb0=$(date +%s)
  seq 1 300 | xargs -P 10 -I{} curl --silent --output /dev/null "http://127.0.0.1:$PORT/openapi.json"
  seq 1 300 | xargs -P 10 -I{} curl --silent --output /dev/null "http://127.0.0.1:$PORT/readyz"
  echo "-- burst took $(( $(date +%s) - tb0 )) s; GET /readyz now $(status /readyz)"
  rss pilot-b
  echo "-- 10 s later"; sleep 10
  rss pilot-b
  docker logs pilot-b 2>&1 | grep -E '^\[pilot\]|heartbeat|running .* queues|listening on' | head -12
  stop_clean pilot-b
fi
echo
echo "== done"
