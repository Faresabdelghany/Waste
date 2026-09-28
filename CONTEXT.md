# Waste Operations

Waste coordinates the planning, delivery, resolution, and billing of waste and recycling services across tenant organizations and their operating scopes.

## Organization and service context

**Company**:
The tenant organization that purchases and operates Waste.
_Avoid_: Account, workspace, customer

**Project**:
A municipality, contract, region, or business unit that defines an operating scope within a company.
_Avoid_: Workspace, tenant

**Company Administrator**:
A company-scoped user responsible for the tenant and authorized across all of its current and future projects.
_Avoid_: Company manager, company owner, master user

**Project Access**:
An explicit grant that permits a company user to work within one or more of that company's projects.
_Avoid_: Company membership, active project

**Service Provider Access**:
An explicit grant that permits a service provider's user to work within the Service Areas currently assigned to that provider, for the operations the grant's role allows. It originates from the Service Area relationship, never from company membership.
_Avoid_: Project access (for provider users), contractor login, company membership

**Customer**:
A person or organization that receives or finances a service.
_Avoid_: Property, payer, account

**Property**:
A physical service address or cadastral location where service is delivered.
_Avoid_: Customer, contact

**Property Group**:
A managed grouping of properties that share administration, reporting, service rules, or agreements.
_Avoid_: Shared collection point, customer

**Shared Collection Point**:
A physical collection location whose services and containers are shared by several participating properties or organizations.
_Avoid_: Property group, warehouse

**Agreement**:
An effective-dated commercial or service entitlement between the company and a customer.
_Avoid_: Subscription, invoice

**Subscription**:
A recurring customer entitlement to a product or collection service under an agreement.
_Avoid_: Agreement, route scheme

**Service frequency**:
The promised collection cadence — a small reusable, project-scoped frequency record (collections per week plus weeks or days between) referenced by containers and products; agreements store none of their own and display what the assigned container inherits. It constrains scheme recurrence, never generates dates.
_Avoid_: Pickup setting, billing frequency, recurrence (the scheme's cadence)

## Service and resources

**Product / Service**:
A sellable service definition with a category, unit, service level, components, and pricing behavior.
_Avoid_: Collection, service provider offering

**Container**:
A physical bin, tank, or unit tracked at a location within a project, classified by container type and waste fraction, serviced inside a Planning Area while in service, and optionally paired with a sensor or bound to an agreement.
_Avoid_: Container type, stock movement, inventory quantity, generic asset

**Asset**:
An umbrella navigation term for physical-resource registries; it is not a separate container lifecycle entity.
_Avoid_: Container when referring to a specific physical bin, tank, or unit

**Container Service Placement**:
The effective-dated record, owned by the Registry, of where a Container serves: the property or shared collection point, the agreement, the product, and the waste fraction. A Container has at most one placement valid at a time.
_Avoid_: Installation record, container location, container address

**Container Asset State**:
The Container's current lifecycle position — in warehouse, in service, in maintenance, or retired — projected from its Stock Movements and never edited directly. Entering service and creating a Service Placement are one action.
_Avoid_: Container status, location field, two Container aggregates

**Vehicle**:
A powered or towed fleet resource with one or more compartments, each with a capacity for one or more waste fractions, plus compatibility, ownership, and availability, used to execute collection work.
_Avoid_: Route, vehicle allocation, actual assignment

**Driver**:
A qualified and authorized workforce profile that can execute assigned collection work.
_Avoid_: User, planned assignment, actual assignment

**Vehicle Allocation**:
A time-bounded plan that reserves a compatible vehicle and, where applicable, a driver for expected work.
_Avoid_: Actual assignment, route, vehicle

**Warehouse**:
A stock location for containers, spare parts, or other inventory.
_Avoid_: Depot

**Depot**:
An operational base for vehicles, drivers, route departure, and route return.
_Avoid_: Warehouse, unloading station

**Unloading Station**:
A destination where a route unloads collected material and records weight or disposal evidence.
_Avoid_: Depot, warehouse

**Stock Movement**:
An append-only record of receipt, issue, return, transfer, adjustment, or decommission.
_Avoid_: Inventory quantity, balance edit

**Hauler / Service Provider**:
An external organization, typically a hauler, that delivers collection work for a company within awarded Service Areas and is settled for it through Settlements.
_Avoid_: Contractor, customer, project

## Planning and execution

**Collection Calendar**:
The holidays and validity period that determine which planned service dates are valid, maintained per year for one Project; a Route Scheme reads its Project's calendars, never picks one. The working week (the Project's weekend) is a Project attribute, not a calendar field. Customer- or service-scoped calendars are a flagged future capability, not part of the current model (D22).
_Avoid_: Route scheme, route, deviation list, collection deviation (removed 2026-09-03 — holiday and non-working dates are skipped, never moved)

**Holiday list**:
The named set of holidays a Project rests on — one per Project, named on the Project (`Danish public holidays`), dated and named per year on the Project's Collection Calendars, maintained in Settings › Operations › Holiday lists. A Project without one rests on its weekend only. A holiday policy on a Route Scheme decides what a collection on a listed date does.
_Avoid_: Holiday calendar, holiday picker, calendar (for the list itself)

**Route Scheme**:
An effective-dated recurring template — geography, calendar, recurrence, service days, stop selection, default assignment (vehicle, driver, depot, unloading station), and a planned start time — from which service work is generated. The effective period may be open-ended: an omitted effective-to means the scheme continues per its recurrence and calendar until explicitly ended or expired through later configuration. The scheme owns the rules that determine its stops through its Collection Groups: by default a group's Stop Matching Rule resolves the eligible containers at every generation; an explicitly picked container list is the small-scale alternative. Assignment (vehicle, driver, service provider) lives on the groups; the scheme keeps the planning area, calendar, recurrence, depot, and unloading station.
_Avoid_: Route, plan, pickup setting, collection week

**Collection Group**:
One unit of planning inside a Route Scheme: the service days it runs on (a subset of the scheme's), its waste fractions, a vehicle, a default driver, an optional Service Provider, and its stop source — a Stop Matching Rule or explicitly picked containers, never both. Generation writes one Route per group per applicable day; a scheme without explicit groups has one implicit group. Every service day has at least one group, and no vehicle, driver, or container is on two groups the same day.
_Avoid_: Route, run, leg, assignment (unqualified), route scheme

**Stop Matching Rule**:
The declarative stop selection a Route Scheme stores — waste fractions plus an optional vehicle type, resolved against the containers inside the scheme's Planning Area (and project scope) each time routes are generated. The scheme stores the rule, never the resolved result as a stop source, so newly eligible containers join future generations without editing the scheme; each generation stamps the container ids the rule matched beside the run before, as evidence of the run only, and a set that shifts by more than 10 % between two runs raises Attention on the scheme.
_Avoid_: Container list, picked containers, stop list

**Planning Area**:
A versioned geographic area used for route planning, service operations, or notifications. Operational geography, never a commercial award — that is a Service Area. Managed as master data in Settings → Operations → Areas & Zones (since 2026-09-03) and referenced by Route Schemes, Containers, and Service Areas.
_Avoid_: Service area, contract area, zone (unqualified)

**Route**:
A dated, executable unit of work assigned to vehicles and drivers.
_Avoid_: Route scheme, scenario

**Planned Assignment**:
The driver, vehicle, trailer, depot, or service provider expected to execute a route before work starts.
_Avoid_: Actual assignment

**Actual Assignment**:
The driver, vehicle, trailer, depot, or service provider that performed the route.
_Avoid_: Planned assignment

**Pickup**:
One stop-level service action generated inside a dated Route. It exists from planning through execution, and its outcome and proof are recorded against that same Pickup.
_Avoid_: Pickup history, separate service event, property, route

**Stop**:
The route-line presentation of a Pickup — one position (#) within a dated Route's stop list: the Route's active Plan's order where one exists, else the generated order. Presentation only: the Pickup remains the persisted record. Stops exist only once routes are generated; Stop Matching Rule matches are a preview and are never presented as Stops.
_Avoid_: Pickup (as the stored record), matched container, stop preview

**Fact**:
A presentation-only label-and-value line shown on a record in the prototype. The platform stores no Facts: their content lives in typed fields, status, Proof of Service, and Unload records.
_Avoid_: Attribute (as a stored field), event, proof of service

**Driver App**:
The driver's restricted surface for assigned Routes: starting and ending a Session, recording each Pickup's outcome and Proof of Service, and recording Unloads. It shows a driver only their assigned Routes and none of the office's navigation. In the pilot it is a browser page; the term never implies a native application.
_Avoid_: Driver workspace, mobile app (as a promise of a native application), Operate

**Session**:
A driver-app work session on an assigned route, tracking the driver's device state, connectivity, queued actions, and proof progress from assignment to completion. It is created by starting an assigned Route and ended by ending it; a driver has one open Session at a time, and so does a Route.
_Avoid_: Route, actual assignment, pickup

**Command Queue**:
The durable, ordered queue on a driver's device of the commands their actions produce, each kept until the server has answered it. It carries actions through a loss of connectivity and is never the source of truth: the server's records and its receipts are.
_Avoid_: Outbox (the server-side outbox that publishes events between contexts), offline mode, cache

**Scenario**:
An editable planning hypothesis containing selected assumptions and constraints, from which Plans are calculated and compared. A flagged future capability, not part of the current model: until it exists, a Plan records its own inputs.
_Avoid_: Plan, production configuration

**Plan**:
An immutable calculated result for one dated Route — the order its Pickups are executed in, the legs between them and the distance and duration of each — computed from inputs recorded on the Plan itself, whether by an optimiser, by a dispatcher reordering the stops or by measuring the generated order. A Route has at most one active Plan, and without one the generated order stands. A Plan never changes what work the Route holds, and its order is frozen once a Session has started on the Route.
_Avoid_: Scenario, route scheme, optimisation (as the stored result), stop order (as a record of its own)

**Promotion / Go-live**:
The controlled process that turns an approved plan into production configuration.
_Avoid_: Save, publish draft

**Proof of Service**:
Evidence that work occurred, such as time, GPS, photo, weight, signature, or driver event. It is appended and never rewritten; a correction is a new row that names the outcome it replaces.
_Avoid_: Route status, customer note

**Unload**:
A recorded event on a dated Route at an Unloading Station in which the vehicle disposes of some or all of its collected load, with weight or disposal evidence. It is neither a Pickup nor a stop's Proof of Service; a planned unload visit belongs to a Plan.
_Avoid_: Pickup, proof of service, tip, dump

## Resolution and finance

**Ticket**:
A case that owns the resolution of a request, deviation, complaint, task, or operational issue. It is opened by the office, the portal or from an execution event; a re-collection is a Route the ticket names, never one it makes.
_Avoid_: Alert, message

**Alert**:
A condition that requires attention, notification, or acknowledgement and may create or link to a ticket. It is acknowledged and resolved, and links to at most one Ticket.
_Avoid_: Ticket, insight

**Billable Event**:
A validated occurrence that is eligible to become an invoice line.
_Avoid_: Invoice line, route event

**Billing Run**:
A controlled batch that converts eligible billable events into invoices.
_Avoid_: Invoice, settlement

**Invoice**:
An issued customer financial document.
_Avoid_: Settlement, billable event

**Settlement**:
The period calculation and record of amounts due to or from a service provider.
_Avoid_: Invoice, service provider price

**Price List**:
An effective-dated set of explainable customer pricing rules and price rows.
_Avoid_: Service provider price, invoice

**Service Area**:
An effective-dated geographic and service responsibility awarded to a service provider. Its geographic scope references operator-owned Planning Areas — the service provider domain has no zone concept of its own — while the contract's own boundary text stays the authoritative legal boundary.
_Avoid_: Contract area, operational area, route, service provider zone

**Service Area Assignment**:
The effective-dated relationship that links an existing Service Area to one service provider. Assigning or transferring it changes the relationship and preserves the Service Area itself.
_Avoid_: Contract area assignment, create service area, service provider area

## Intelligence and automation

**Insight**:
A governed analytical finding grounded in traceable operational data.
_Avoid_: Alert, automated action

**Suggestion**:
A proposed action that has not been approved or executed.
_Avoid_: Action, approval

**Approval**:
An explicit decision that authorizes or rejects a controlled change.
_Avoid_: Suggestion, execution
