---
status: accepted
date: 2026-09-17
---

# Single domain data path

Supabase exposes tables to the browser through PostgREST and Realtime, and its idiom is to implement authorisation as row-level security. Our authorisation is not a tenant column: a Service Provider's user reaches a Route through Service Provider Access, a Service Area Assignment that is valid on the service date, and the geographic scope of that Service Area. Implementing that twice, once in the API and once in SQL policies, guarantees drift.

We decided that domain tables are never reachable from the browser. They live in the Postgres schema `wms`, which is not listed in Supabase's exposed schemas, so PostgREST and Realtime cannot reach them by construction. All web reads and writes go through the Hono API. The driver app reads through PowerSync and writes through the API. Realtime comes from PowerSync live queries on the driver app and from server-sent events off the API for the web. RLS policies exist on `wms` tables only as coarse tenant fences, and the API sets the request's claims per transaction so that backstop is real. The Supabase JWT carries only the user id and home company id; every grant is looked up per request so revocation is immediate.

## Considered options

- Direct Supabase reads for "simple" tables such as Containers, with the API only for sensitive operations. Rejected: every direct read becomes a contract on table shape and policy, and the set of simple tables always grows.
- Better Auth on Supabase Postgres for its organisation model. Rejected for now: Supabase Auth's JWT is consumed natively by PowerSync and RLS. Better Auth remains the fallback if the platform changes.

## Consequences

- Company, Project Access, Service Provider Access, and roles are our own tables, projected into the JWT only as the home company id through the custom access token hook.
- Any genuinely public or user-own dataset, such as a citizen's own agreements, is an explicitly exposed read model in a separate schema, not a relaxation of this rule.
- We give up PostgREST convenience for domain data. That is the point.
