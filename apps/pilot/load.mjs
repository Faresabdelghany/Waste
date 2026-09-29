#!/usr/bin/env node
// PROTOTYPE — throwaway, ticket #134: the load the hosted gates are measured
// under. CONCURRENCY clients loop over PATHS against BASE_URL for
// DURATION_SECONDS, each request timed and its body read; TOKEN, when set,
// goes out as the bearer and the authenticated paths join the mix. Prints one
// JSON line per path (count, statuses, p50/p95/max in ms, bytes read) and a
// total, so a run is a line on the ticket.
//
//   BASE_URL=https://waste-pilot.onrender.com CONCURRENCY=3 DURATION_SECONDS=300 node apps/pilot/load.mjs
const base = process.env.BASE_URL
if (!base) throw new Error("BASE_URL is required")
const token = process.env.TOKEN
const concurrency = Number(process.env.CONCURRENCY ?? 3)
const durationMs = Number(process.env.DURATION_SECONDS ?? 60) * 1000
const open = ["/healthz", "/readyz", "/openapi.json"]
const authenticated = ["/me", "/company", "/projects", "/service-providers", "/roles", "/users", "/customers?limit=200"]
const paths = process.env.PATHS ? process.env.PATHS.split(",") : token ? [...open, ...authenticated, ...authenticated] : open

const results = new Map(paths.map((path) => [path, { latencies: [], statuses: {}, bytes: 0, errors: 0 }]))
const deadline = Date.now() + durationMs
let next = 0

async function client() {
  while (Date.now() < deadline) {
    const path = paths[next++ % paths.length]
    const entry = results.get(path)
    const started = performance.now()
    try {
      const response = await fetch(`${base}${path}`, {
        headers: token && authenticated.includes(path) ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(30_000),
      })
      const body = await response.arrayBuffer()
      entry.latencies.push(performance.now() - started)
      entry.statuses[response.status] = (entry.statuses[response.status] ?? 0) + 1
      entry.bytes += body.byteLength
    } catch {
      entry.errors += 1
    }
  }
}

const startedAt = Date.now()
await Promise.all(Array.from({ length: concurrency }, client))
const seconds = (Date.now() - startedAt) / 1000
const quantile = (sorted, q) => (sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]))
let total = 0
for (const [path, { latencies, statuses, bytes, errors }] of results) {
  const sorted = [...latencies].sort((a, b) => a - b)
  total += latencies.length
  console.log(JSON.stringify({ path, count: latencies.length, errors, statuses, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), max: quantile(sorted, 1), kib: Math.round(bytes / 1024) }))
}
console.log(JSON.stringify({ total, seconds: Math.round(seconds), perSecond: Math.round((total / seconds) * 10) / 10, concurrency, at: new Date().toISOString() }))
