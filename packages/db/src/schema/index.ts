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
// Registry's records and Organisation & Access's accounts — then Finance &
// Contracting (Issue #112, migration 0010), one file of sixteen tables that
// reference every context before it, and which the Registry's agreements.ts
// imports back for the list an agreement is priced under, a cycle drizzle
// tolerates since every reference is read inside a table's extra-config
// callback and never at a module's top level — then Generation (Issue #97
// part B, migration 0012), one file of two tables that reference Planning's
// scheme and group, and whose run Execution's `route` names back, which is
// an import in execution.ts and no reordering here. What is exported here is
// what `pnpm db:generate` sees — the CSV import's run and its rows (#291
// slice 12, migration 0018), then the Pickup Exceptions' codes and rules (M5
// of #293), which Execution's pickup and proof name back — and what the hand-written gate
// (__tests__/hand-written.test.ts) holds to its fence and trigger, or to its
// fence and revoke for a ledger. The Drop-off Points (Issue #293, M3) come
// next: four tables over the project, the fractions and nothing later; then
// the fleet's emissions (M10 of #293): a fuel's factor, and a vehicle type's
// consumption by fuel.
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
export * from "./availability"
export * from "./execution"
export * from "./resolution"
export * from "./finance"
export * from "./generation"
export * from "./routing"
export * from "./sorting-guide"
export * from "./audit"
export * from "./imports"
export * from "./drop-off-points"
export * from "./pickup-exceptions"
// Bulky-waste booking (O11 of #290): the schedules of an area's collection days and the bookings that take a slot of one.
export * from "./bulky"
export * from "./emissions"
// A customer's Applications and the office's Decisions on them (M7 of #293).
export * from "./applications"
export * from "./sustainability"
// Recycling-centre visits (M4 of #293): the register, the ledger and the Visit Rules.
export * from "./site-visits"
// The coordination between the office and a Service Provider: proposals, follow-ups and notes (#474).
export * from "./service-provider-activities"
// Messaging (#291 C15): the office's templates and the delivery log.
export * from "./messaging"
// A staff member's notification preferences (O16 of #290).
export * from "./notifications"
