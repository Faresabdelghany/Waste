// The process's id minter, as apps/api reads it: `newId` and `createIdMinter`
// live in `@waste/db/ids` since Issue #109 part B and #112 part B, when the
// worker became the second process writing rows and the shared write
// statements (`@waste/db/commands/*`) took their minter from the one package
// both processes consume — one sequence per process, whichever of the API,
// the commands or the worker's jobs asks, so a route and the command it calls
// count up from the same last id. This module is the API's name for it, so a
// route writes `id: newId()` where it always did; the header of
// `packages/db/src/ids.ts` says the rest.
export { createIdMinter, newId, type IdMinter } from "@waste/db/ids"
