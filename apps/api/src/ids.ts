// The process's id minter, as the API imports it. The minter itself moved to
// `@waste/db/ids` with the command functions the worker runs (Issue #112 part
// B): one sequence per process, whichever of the API, the commands or the
// worker's jobs asks, so a route and the command it calls count up from the
// same last id. The forty-odd importers here read it from this path as they
// did; the header of `packages/db/src/ids.ts` says the rest.
export { createIdMinter, newId, type IdMinter } from "@waste/db/ids"
