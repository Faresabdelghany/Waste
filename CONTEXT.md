# WasteHero Operations

WasteHero coordinates the planning, delivery, resolution, and billing of waste and recycling services across tenant organizations and their operating scopes.

## Organization and service context

**Company**:
The tenant organization that purchases and operates WasteHero.
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
An effective-dated commercial or service entitlement between a provider and a customer.
_Avoid_: Subscription, invoice

**Subscription**:
A recurring customer entitlement to a product or collection service under an agreement.
_Avoid_: Agreement, route scheme

## Service and resources

**Product / Service**:
A sellable service definition with a category, unit, service level, components, and pricing behavior.
_Avoid_: Collection, contractor service

**Container**:
A physical bin, tank, or unit tracked at a location within a project, classified by container type and waste fraction, and optionally paired with a sensor or bound to an agreement.
_Avoid_: Container type, stock movement, inventory quantity, generic asset

**Asset**:
An umbrella navigation term for physical-resource registries; it is not a separate container lifecycle entity.
_Avoid_: Container when referring to a specific physical bin, tank, or unit

**Vehicle**:
A powered or towed fleet resource with capacity, compatibility, ownership, and availability used to execute collection work.
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

**Hauler / Contractor**:
An external service provider that delivers work for a company.
_Avoid_: Customer, project

## Planning and execution

**Collection Calendar**:
The working days, holidays, and validity period that determine which planned service dates are valid for a project, customer, or service.
_Avoid_: Route scheme, route, deviation list

**Collection Deviation**:
An approved replacement of one planned service date with another, preserving the original service promise.
_Avoid_: Calendar exception, holiday rule

**Route Scheme**:
An effective-dated recurring template — geography, calendar, recurrence, and service days — from which service work is generated.
_Avoid_: Route, plan, pickup setting, collection week

**Planning Area**:
A versioned geographic area used for route planning, service operations, or notifications. Operational geography, never a commercial award — that is a Contract Area.
_Avoid_: Contract area, zone (unqualified)

**Route**:
A dated, executable unit of work assigned to vehicles and drivers.
_Avoid_: Route scheme, scenario

**Planned Assignment**:
The driver, vehicle, trailer, depot, or contractor expected to execute a route before work starts.
_Avoid_: Actual assignment

**Actual Assignment**:
The driver, vehicle, trailer, depot, or contractor that performed the route.
_Avoid_: Planned assignment

**Pickup**:
One stop-level service action generated inside a dated Route. It exists from planning through execution, and its outcome and proof are recorded on that same Pickup.
_Avoid_: Pickup history, separate service event, property, route

**Scenario**:
An editable planning hypothesis containing selected assumptions and constraints.
_Avoid_: Plan, production configuration

**Plan**:
An immutable result calculated from a scenario.
_Avoid_: Scenario, route scheme

**Promotion / Go-live**:
The controlled process that turns an approved plan into production configuration.
_Avoid_: Save, publish draft

**Proof of Service**:
Evidence that work occurred, such as time, GPS, photo, weight, signature, or driver event.
_Avoid_: Route status, customer note

## Resolution and finance

**Ticket**:
A case that owns the resolution of a request, deviation, complaint, task, or operational issue.
_Avoid_: Alert, message

**Alert**:
A condition that requires attention, notification, or acknowledgement and may create or link to a ticket.
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
The period calculation and record of amounts due to or from a contractor.
_Avoid_: Invoice, contractor price

**Price List**:
An effective-dated set of explainable customer pricing rules and price rows.
_Avoid_: Contractor price, invoice

**Contract Area**:
An effective-dated geographic and service responsibility awarded to a contractor.
_Avoid_: Operational area, route

**Contract Area Assignment**:
The effective-dated relationship that links an existing Contract Area to one contractor. Assigning or transferring it changes the relationship and preserves the Contract Area itself.
_Avoid_: Create contract area, contractor area

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
