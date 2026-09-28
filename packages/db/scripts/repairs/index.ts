// The active repairs (Issue #152): the only modules the `repair` operation
// can run, each under the id it is dispatched with. A repair is a file beside
// this one, `<issue>-<slug>.ts`, exporting `repair` (src/pilot/repair.ts says
// what it holds and how it runs), and a line here importing it by its own
// literal path, reviewed with it:
//
//   "160-backfill-route-numbers": async () => (await import("./160-backfill-route-numbers")).repair,
//
// Once its postcondition holds on the Pilot and the migration that needed it
// is applied and verified, the line leaves this map and the file moves to
// applied/ with the issue and the release it ran in, never deleted and never
// edited again (migrations/README.md).
import type { RepairManifest } from "../../src/pilot/repair"

export const ACTIVE_REPAIRS: RepairManifest = {}
