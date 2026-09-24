// drizzle-kit's entry point and the shape `createDb` types its queries with.
// Tables arrive context by context, in the order their migrations create
// them: Organisation & Access (Issue #70, migration 0002) first; Registry
// (Issue 4) next. What is exported here is what `pnpm db:generate` sees and
// what the hand-written gate (__tests__/hand-written.test.ts) holds to its
// fence and trigger.
export * from "./wms"
export * from "./organisation"
export * from "./access"
