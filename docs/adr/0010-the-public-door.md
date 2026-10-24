---
status: proposed
date: 2026-10-24
---

# The public door

Until now every API route asked for a token, and every request ran as `wms_api` inside the company its token named (ADR-0001). The citizen-facing scenarios that the market comparison (#293) found in every comparable product are read by people who have no account and never will: the sorting guide (M1), the collection days of an address (M2) and the map of drop-off points (M3). A municipality publishes these on its own website. They need a way in without a login, and that way must not widen what any signed-in route can reach.

## Decision

**A project publishes itself under a slug, and the public door opens only published projects.** `project.public_slug` is null until the office sets it (`PATCH /projects/:id`). It is lowercase words joined by hyphens, 3–63 characters, and unique across every company, since one public address names one project. Public routes live under `/public/:slug/…` and take no token. A slug nobody publishes under, and a path segment that is not a slug at all, get the same 404, so the door says nothing about projects it does not open.

**A public request reads as a role of its own, `wms_public`, never as `wms_api`.** The role logs in as nobody. `wms_api` holds it `WITH INHERIT FALSE, SET TRUE`, so a public transaction says `SET LOCAL ROLE wms_public`. Every statement after that runs with this role's rights alone, and the role ends with the transaction (`withPublishedProject`, `@waste/db/public-door`). The role holds SELECT on exactly the columns `PUBLIC_DOOR_TABLES` names (`packages/db/src/sql/public-door.ts`), and no other right on any table, present or future. Every tenant fence is written `TO wms_api` and forced, so the role's rows come from policies of its own:
- a project while it is published, which is how a request finds the company it then sets;
- a fraction inside that company;
- an item inside that company, only while it is published and its project is too.

A route that asks for more than this gets 42501, not a wider answer. `public-door.test.ts` holds the role to the list column by column.

**Each client gets an allowance per minute, counted in memory**: `PUBLIC_REQUESTS_PER_MINUTE`, 60 unless set, answered with 429 and `Retry-After` when spent. With no proxy trusted (`PUBLIC_TRUSTED_PROXIES` unset or 0), the client is the socket's peer and `X-Forwarded-For` is ignored, since nobody but the client wrote it. Behind N trusted proxies, each of which appends the address it was reached from, the client is the entry the outermost proxy wrote, the Nth from the end. A header shorter than that falls back to the peer. An IPv6 address is counted by its /64, the block one host is handed. The API runs as one instance on the Pilot (ADR-0008), so one process's memory is the whole count, and a restart forgets at most one minute. The Pilot's value of `PUBLIC_TRUSTED_PROXIES` is set when the host's proxy chain is known. Public answers carry `Cache-Control: public, max-age=60`, so a change the office publishes reaches the public within a minute, and so does an unpublishing.

**No write goes through the door in this decision.** Search analytics, citizen reports and bookings need a write path for anonymous requests, and that is decided with its slice. When it is, the role gains INSERT on a named ledger, or a separate door gets its own role. The role never takes the API's rights.

## Considered options

- **Public reads as `wms_api` with a fixed company set.** It needs no new role, but any public route that forgets its project or status filter would read every row the company has. Rejected: the boundary would be the route's code rather than the database.
- **A separate login role with its own pool and URL.** The isolation is the same, but the Pilot would need a new hosted login, a secret and a second pool inside the pooler's 15 per role (ADR-0008), for nothing `SET ROLE` does not already give. Rejected.
- **`SECURITY DEFINER` functions that return the public answers.** They are narrow, but each public answer would become a hand-written SQL function outside Drizzle, with the search ranking in PL/pgSQL. Rejected in favour of the role, with the ranking in `@waste/domain`.
- **Signed public tokens per municipality** (an API key in the embed). These belong to integrators (#293, M8), not residents. A key in a web page is public anyway, so it adds nothing a slug does not.
- **Rate limiting at the proxy or a CDN.** Suga's free tier offers none (ADR-0008). Its place stays open for Gate B.

## Consequences

- Migration 0017 creates the role, its column grants and its policies below the Sorting Guide's table. `_fingerprint.txt` records each grant and policy, so a drift is caught by `db:fingerprint --check`.
- A public slice adds its tables and columns to `PUBLIC_DOOR_TABLES` and its grants and policies to its own migration. The test then demands exactly that list, and a column left out is a column no public answer can carry.
- `GET /openapi.json` documents the public routes with no security. `app.test.ts` lists them beside the probes as the operations that need no token.
- Embedding on another origin needs CORS on `/public/*` alone. M2's widget brings it.
