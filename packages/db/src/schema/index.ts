// drizzle-kit's entry point and the shape `createDb` types its queries with.
// Tables arrive context by context, in the order their migrations create
// them: Organisation & Access (Issue #70, migration 0002) first, then the
// Registry (Issue #78, migration 0004), whose four files are ordered so that a
// table is exported after the tables it references, then Planning (Issue #97,
// migration 0006), whose three files follow the same rule, then Resources
// (Issue #101, migration 0007), whose five do too — and whose vehicle types,
// vehicles, drivers, depots and stations Planning's route-schemes.ts now
// references, which is an import there and no reordering here, since
// drizzle-kit sorts a module's exports — then Execution (Issue #104,
// migration 0008), one file of seven tables that reference all four contexts
// before it — then Resolution (Issue #109, migration 0009), one file of three
// tables that reference Execution's routes and pickups, Resources' fleet, the
// Registry's records and Organisation & Access's accounts. What is exported
// here is what `pnpm db:generate` sees and what the hand-written gate
// (__tests__/hand-written.test.ts) holds to its fence and trigger, or to its
// fence and revoke for a ledger.
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
export * from "./fleet-types"
export * from "./places"
export * from "./fleet"
export * from "./stock"
export * from "./allocations"
export * from "./execution"
export * from "./resolution"
