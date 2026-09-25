// drizzle-kit's entry point and the shape `createDb` types its queries with.
// Tables arrive context by context, in the order their migrations create
// them: Organisation & Access (Issue #70, migration 0002) first, then the
// Registry (Issue #78, migration 0004), whose four files are ordered so that a
// table is exported after the tables it references, then Planning (Issue #97,
// migration 0006), whose three files follow the same rule. What is exported
// here is what `pnpm db:generate` sees and what the hand-written gate
// (__tests__/hand-written.test.ts) holds to its fence and trigger.
export * from "./wms"
export * from "./organisation"
export * from "./access"
export * from "./catalogue"
export * from "./customers"
export * from "./agreements"
export * from "./containers"
export * from "./planning-areas"
export * from "./collection-calendars"
export * from "./route-schemes"
