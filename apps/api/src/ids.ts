// The process's id minter, as apps/api reads it: `newId` and `createIdMinter`
// live in `@waste/db/ids` since Issue #109 part B, when the worker became the
// second process writing rows and the shared write statements
// (`@waste/db/commands/*`) took their minter from the one package both
// processes consume. This module is the API's name for it, so a route writes
// `id: newId()` where it always did and the sequence stays one per process.
export { createIdMinter, newId, type IdMinter } from "@waste/db/ids"
