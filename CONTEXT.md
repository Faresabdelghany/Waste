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
A company-scoped user responsible for the tenant and authorized across all of its current and future projects. One Company Administrator is the primary administrator, the company's protected last way in: it cannot be deactivated or narrowed, and the flag moves to another active account that reaches every project.
_Avoid_: Company manager, company owner, master user

**Project Access**:
An explicit grant that permits a company user to work within one or more of that company's projects.
_Avoid_: Company membership, active project

**Service Provider Access**:
An explicit grant that permits a service provider's user to work within the Service Areas currently assigned to that provider, for the operations the grant's role allows. It originates from the Service Area relationship, never from company membership.
_Avoid_: Project access (for provider users), contractor login, company membership

**User Account**:
A company's record of a person who may work in Waste, carrying their role and their Project Access or Service Provider Access.
_Avoid_: User, member, login

**Login**:
The identity a person signs in with, bound to exactly one User Account. In the Pilot, that binding is established on first sign-in.
_Avoid_: Account, credentials, auth user

**Invitation**:
A User Account no Login is bound to yet.
_Avoid_: Pending user, unconfirmed account

**Published Project**:
A project the company has made readable to the public under its public slug (`kystbyen`), through the public door: anonymous pages a municipality links from its own website. An unpublished project has no public pages.
_Avoid_: Public tenant, open project, portal (the portal is for signed-in customers)

**Sorting Guide**:
A project's public answer to "where does this go?": the Sorting Guide Items a resident searches by name or synonym, each naming the waste fraction it belongs in and how to present it.
_Avoid_: Waste wizard, recycling dictionary, A–Z list

**Sorting Guide Item**:
One thing a Sorting Guide knows, such as a pizza box or a battery: its name, the other words it is known by, its waste fraction where it has one, and its instructions. It is a draft until published, and withdrawn rather than deleted.
_Avoid_: Article, product (a Product is what is sold), entry

**Collection Day**:
A day a property's containers are collected, as generation plans it: the route that stands keeps its own day, and the rest follow the scheme's recurrence and holiday policy, a skipped holiday shown as such. What a published project's calendar by address and its feed tell a resident.
_Avoid_: Pickup day (a Pickup is one stop on a route), bin day, tømmedag in copy that is not Danish

**Customer**:
A person or organization that receives or finances a service.
_Avoid_: Property, payer, account

**Contact Person**:
A named person who speaks for an organisation Customer, with a role (primary, billing, operations, on-site, other) and the channels they are reached on, an e-mail or a phone or both. A person Customer is their own contact and has none; one who leaves is made inactive, never deleted.
_Avoid_: Contact (the prototype's word for a person Customer), representative, user

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

**Application**:
A customer's written request to change how they are served or billed — an exemption, a pause, a longer interval, home composting, a shared bin, assisted collection, a fee put right — which the office reviews and decides. Received, in review, decided or withdrawn; whether its decision is still in force is read from the decision's period, never set.
_Avoid_: Request, case (that is a Ticket), exemption (that is one kind)

**Decision**:
The office's verdict on an Application: granted, partly granted or refused, with what it holds the customer to, the period a grant is in force, and how to appeal anything less than a grant in full. Appended, never rewritten: an appeal reopens the Application and the next Decision follows the last.
_Avoid_: Approval (a controlled change's), ruling

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

**Shift**:
A Driver's working day on the project's clock, from a start to a later end on the same day, with at most one break of so many minutes, inside a window of its own or anywhere in the shift. The Route's planned Driver's shift is what route optimisation plans the break by, and a Route whose planned day runs outside it is over shift: still planned, and flagged.
_Avoid_: Working hours, roster, schedule

**Service Window**:
When in the day a stop may be served: a Property's access hours and an Agreement's promised window, each optional, the stop's window being where the two overlap. Route optimisation holds a stop inside it.
_Avoid_: Time slot, booking slot, opening hours (a station's)

**Pre-trip Check**:
A driver's walk-round of a Vehicle before or during the day, answering every item of the checklist its vehicle type holds — passed, or a defect with what was seen — and the odometer and engine hours where read. A check is kept as it was answered, whatever the checklist says later.
_Avoid_: Inspection report, vehicle audit, service

**Vehicle Defect**:
A checklist item a Pre-trip Check failed, open until the office marks it resolved. A defect of a critical item takes the Vehicle out of service — its status maintenance — until the office mends it and sets it active again; every check that finds defects opens the office one ticket for them.
_Avoid_: Fault, damage report, container defect (a container's)

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

**Treatment**:
How a waste fraction is handled once collected: reuse, recycling (composting and digestion among it), energy recovery, or disposal. A Customer's recycling rate is read from it.
_Avoid_: Disposal method, processing, destination

**Emission Factor**:
A published figure of CO₂e per unit in force over a period, with the source it is quoted from. A fuel has grams per litre, kilogram or kilowatt-hour burnt. A waste fraction has kilograms per tonne its Treatment emits, and per tonne it avoids where the Treatment displaces anything. Revised by adding the next period, never by editing a figure.
_Avoid_: Carbon factor, emission rate

**Drop-off Point**:
A place residents bring waste to themselves, on a project's public map: a recycling centre (staffed, with opening hours, many fractions) or a bring bank (bins on a street, usually open always). It carries the fractions it takes, weekly hours, dated exceptions, and whether the project's holidays close it.
_Avoid_: Unloading Station (where the operation's own vehicles empty), Depot, container (a bring bank's bins are not the platform's Containers), genbrugsstation in copy that is not Danish

**Access Credential**:
A vehicle plate or an access card a project's recycling centres admit by, effective-dated and ended or blocked, never deleted. A business holds one under its Customer, its visits charged to the Agreement the credential names; a household under its Property. Its value is stored upper case with no spaces or hyphens, so a plate is one value however it is written, and one credential of a plate or card number is in force at a time.
_Avoid_: Permit, pass, badge, key card, licence (a driver's)

**Site Visit**:
One arrival at a recycling centre, recorded by the attendant at check-in or by the gate: the site, the instant and the project's day, how it was identified (a plate, a card, or the Property the attendant found), the fractions brought, and whom it was for. Admitted or refused with the reason — a refused visit is still recorded — and voided with a reason when it was a mistake, never deleted, since the ledger is the evidence for its charge.
_Avoid_: Drop-off (a Drop-off Point is the place), check-in (the attendant's act that records one), trip, pickup

**Visit Rule**:
A project's effective-dated rule for charging its recycling centres' visits: a household's free visits per calendar year and a ladder of per-visit products after them, the last step repeating; the free fractions, whose visits are neither counted nor charged; a business's per-visit product and the annual-access product whose subscription includes its visits; and the threshold of visits in a window that flags a Property as a likely trade. One is in force per project at a time.
_Avoid_: Quota (one part of the rule), tariff, price list (the rule names products; the Price List prices them)

**Stock Movement**:
An append-only record of receipt, issue, return, transfer, adjustment, or decommission.
_Avoid_: Inventory quantity, balance edit

**Stock Minimum**:
The fewest containers of one type the office wants a Warehouse to hold in stock; a container in maintenance does not count towards it. The stock is read off the Stock Movements against it, "below minimum" where fewer stand there; nothing is alerted or ordered from it.
_Avoid_: Reorder level, safety stock, par level

**Decommission Reason**:
Why a container was scrapped: one of the company's own list, kept in the master data, which a decommission names beside an optional note. A reason is retired rather than deleted, so a decommission given it still reads it.
_Avoid_: Scrap code, disposal reason, retirement reason

**Sensor**:
A fill-level device the company owns, identified by the identifier its network knows it by, which reports how full the Container it is paired with is. A Sensor is retired rather than deleted; a retired one's readings are refused.
_Avoid_: Device (the Driver App's phone), IoT unit, tag

**Sensor Pairing**:
The effective-dated record that a Sensor measures a Container, with the full threshold, in whole percent, at which the container is full enough to raise an Alert. A Sensor measures one Container at a time, and a Container is measured by one Sensor at a time; the pairing is the bin's, not its place's, so it outlives a move.
_Avoid_: Installation, assignment, mounting

**Fill Reading**:
One measurement a Sensor sent: when it was measured, how full the Container was in whole percent, and the battery and signal strength where the vendor reports them. Readings are a ledger a vendor's integration appends; a reading is tied to the Sensor Pairing in force on its day.
_Avoid_: Telemetry (as the record), ping, measurement

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
An effective-dated recurring template — geography, calendar, recurrence, service days, stop selection, default assignment (vehicle, driver, depot, unloading station), and a planned start time — from which service work is generated. The effective period may be open-ended: an omitted effective-to means the scheme continues per its recurrence and calendar until explicitly ended or expired through later configuration. The scheme owns the rules that determine its stops through its Collection Groups: by default a group's Stop Matching Rule resolves the eligible containers at every generation; an explicitly picked container list is the small-scale alternative. Assignment (vehicle, driver, service provider) lives on the groups; the scheme keeps the planning area, calendar, recurrence, depot, and unloading station. One scheme of a name is in force at a time in a project: its next version is a new scheme of the same name from a day, the old one ending the day before. Plan Ahead keeps a scheme's coming days planned each night, a week unless the scheme says otherwise. A scheme is never deleted: archiving it ends it from a day, cancels its planned routes from then and keeps everything it made as history.
_Avoid_: Route, plan, pickup setting, collection week; delete (for archive)

**Season**:
A stretch of every year — a first day and a last day, the same each year, over the new year where it ends before it starts — in which a Route Scheme serves its service days at another cadence than its own (garden waste weekly in summer, every other week in winter). A scheme's seasons share no day; outside every season the scheme runs at its own cadence, and a daily scheme has none. Not a period of the scheme: the scheme's effective period still bounds every season.
_Avoid_: Period, version, seasonal depot

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
A dated, executable unit of work assigned to vehicles and drivers. Generated from a Route Scheme, or made by the office as an ad-hoc Route with no scheme, which generation never touches.
_Avoid_: Route scheme, scenario

**Planned Assignment**:
The driver, vehicle, trailer, depot, or service provider expected to execute a route before work starts.
_Avoid_: Actual assignment

**Actual Assignment**:
The driver, vehicle, trailer, depot, or service provider that performed the route.
_Avoid_: Planned assignment

**Dispatch**:
The office's release of a planned Route to execution: it requires a Planned Assignment's driver, marks the Route ready, and freezes it against regeneration. Dispatch moves no vehicle and starts no Session — the driver starting the Route does that.
_Avoid_: Assign (dispatch releases an assignment, it does not create one), start (the driver's act), send

**Pickup**:
One stop-level service action inside a dated Route, generated from its scheme or added by the office — a container, or an address with the waste fraction collected there — which generation then leaves where the office put it. It exists from planning through execution, and its outcome and proof are recorded against that same Pickup. Its service says what the action is: an emptying of its container — generation's only service — a Work Order, or a Bulky Booking's collection. The office's emptying of a container one of generation's emptyings on the Route visits too is an Extra Emptying.
_Avoid_: Pickup history, separate service event, property, route, Product (a Pickup's service is what it does; the Product prices it)

**Work Order**:
A Pickup the office books whose service is not an emptying: a delivery, a removal, a swap, a repair or a wash of a container. Its outcome and proof are recorded as any Pickup's; one not done is the office's task to book again, never a missed collection. A delivery, a removal and a swap are Ledger Work Orders: each books at the office what its Stock Movements need — a delivery the Subscription the container will serve under, a removal and a swap the Warehouse the container taken goes back to, a swap its replacement — and the driver's completion records those movements. A container from stock a planned delivery or swap names is held for it: no second one may name it. A movement the ledger refuses never refuses the completion; it becomes an internal-task Ticket saying why.
_Avoid_: Job, task (a Ticket's kind), collection

**Bulky Booking**:
A Customer's booked collection of bulky items at one of their places, a Property or a Shared Collection Point, on a day of a Bulky Schedule: the Agreement it is charged to, the waste fraction and the items, each a description and a count. It takes one slot of its day, and freezes the Planning Area, the Bulky Schedule and the Product it was booked under. The office routes it as a Pickup at its address with no container, on a Route running on its day; its completion is charged at its Product to its Agreement. Booked, routed, collected or cancelled is read from its cancellation and its stop; a stop missed leaves it booked, the office's to move and route again.
_Avoid_: Order, reservation, appointment, Work Order (a Work Order is of a container)

**Bulky Schedule**:
A Planning Area's effective-dated recurrence of the days bulky waste is collected there — a Route Scheme's frequency, service days, week rotation and holiday policy — with the slots each day has, one per Bulky Booking, and the Product a booking is charged at, sold by the job. One of an area is in force at a time; a place is booked on the days of the schedule of the area it lies in.
_Avoid_: Bulky route, slot calendar, Route Scheme (a scheme generates Routes; a schedule only offers days)

**Pickup Exception**:
A Pickup whose outcome the customer caused — failed or skipped for a driver's reason other than capacity or safety, or completed but tagged with a Contaminant Code. It may be charged under its project's rules, the first few in a window free and the rest stepped up a ladder of products, and is read in its Property's or Shared Collection Point's exception history.
_Avoid_: Alert, exception (unqualified — the alerts module's legacy id), deviation, missed collection (a missed collection is the operator's)

**Contaminant Code**:
A company's own name for the wrong waste in a bin — plastic in organic waste, food in paper — which a driver or the office tags a stop with, optionally narrowed to the waste fractions it is found in. Retired by its status, never deleted, since a stop keeps the code it was tagged with.
_Avoid_: Contamination reason (the reason is `contamination`; the code says which), fault code

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

**Position**:
Where a Session's vehicle was at one instant, as the driver's device recorded it while the Session ran unpaused with its Route on screen; the Positions of a Session in order are its **Track**. Personal location data, kept for the retention days and then deleted. A Proof of Service's location is the place an action was recorded, not a Position.
_Avoid_: GPS ping, breadcrumb, trace, telemetry (as the record)

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

**Transfer Note**:
The document that goes with an Unload's load from the company that collected and carried it to the Unloading Station that took it: the parties, the waste fraction with its waste code and whether it is hazardous, the weights, and when. One per Unload the station accepted; a refused load was not transferred and has none, and a corrected Unload's note is its correction's.
_Avoid_: Consignment note, waybill, disposal receipt

## Resolution and finance

**Ticket**:
A case that owns the resolution of a request, deviation, complaint, task, or operational issue. It is opened by the office, the portal or from an execution event; a re-collection is a Route the ticket names, never one it makes.
_Avoid_: Alert, message

**Message Template**:
A project's text for one kind of message the office sends — an e-mail with a subject, or a text message — for service (sent only to a Customer who allows service messages) or for billing (sent whatever they chose), its values named as `{{placeholders}}`. Retired by its status, never deleted.
_Avoid_: Notification template, letter

**Message**:
One e-mail or text message rendered from a Message Template to a Customer or one of its Contact Persons, kept on the delivery log with the address it went to and how its sending stands: queued, sent, failed, or withheld for want of consent. Sent through a log-only sender until a card-free provider is chosen.
_Avoid_: Notification, SMS (one channel of it), mail

**Alert**:
A condition that requires attention, notification, or acknowledgement and may create or link to a ticket. It is acknowledged and resolved, and links to at most one Ticket. The office raises one by hand; the worker's rules raise one per occurrence of a route not started, a device silent, a licence running out, a ticket overdue, a position stale, or a Container filled past its Sensor Pairing's threshold — an overdue ticket's alert is about that Ticket, never a new one — and resolve it when the condition clears.
_Avoid_: Ticket, insight

**Team**:
The people of the company a Ticket waits with, such as customer service or the container desk, with its members. A Ticket names at most one Team beside its assignee; a project names a default Team per kind, which a ticket opened without one takes. A Team's queue is its open tickets with no assignee, and anyone who works tickets takes one, member or not. A Team is retired rather than deleted, so a ticket it held still names it.
_Avoid_: Group, queue, department

**SLA Target**:
The hours a project gives a Ticket of a priority, of every kind or of one kind, from when its issue or request happened to its due date; one kind's target wins over every kind's. Opening a ticket without a due date sets one from it, and an open ticket past its due date is overdue.
_Avoid_: Deadline, response time, ticket type

**Billable Event**:
A validated occurrence that is eligible to become an invoice line.
_Avoid_: Invoice line, route event

**Work Order Charge**:
The Product a Project bills each Work Order's service at — a delivery, a removal, a swap, a repair, a wash — charged when the Work Order is done, to the container's Agreement, a delivery's through the Subscription it books. A service the Project names no Product for is charged nothing, and a Work Order booked to answer a Ticket never is: the Ticket's charge is the one.
_Avoid_: Service fee, job price

**Hire**:
What a Subscription to a Product sold by the day charges each of its containers: the days it stands on site, from the day it is delivered to the day it is taken back, by calendar month in arrears, each placement's Free Days not charged. A pause of the Subscription does not stop a Hire, since the container still stands there.
_Avoid_: Rental (a Product sold by the month is a recurring charge), demurrage

**Free Days**:
A Hire Product's first days of each placement on site, charged nothing, counted from the delivery across the months.
_Avoid_: Grace period

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

**Indexation**:
A percent applied to prices from a day — a customer price list's rows, or a provider's or an award's prices — as new rows and never an update: each price in force on the day ends on it, and its successor carries the indexed price and names the row it was indexed from. The office calls it Apply index; the chain of rows is a price's indexation history.
_Avoid_: Price update, repricing, tariff edit

**Service Area**:
An effective-dated geographic and service responsibility awarded to a service provider. Its geographic scope references operator-owned Planning Areas — the service provider domain has no zone concept of its own — while the contract's own boundary text stays the authoritative legal boundary.
_Avoid_: Contract area, operational area, route, service provider zone

**Service Provider Activity**:
One item of coordination between the office and one Service Provider about the work it holds under an award, numbered `ACT-<n>`: a proposal of a protected change, which asks for the office's Approval — a route-day change, a Collection Group of a scheme the provider serves run on other days from a day, a vehicle change, the group run with another vehicle and optionally another driver, a stop-set change, a group that picks its stops run on another list of containers, or a waste-fraction change, a rule group's rule collect other fractions — a compliance follow-up the office raises with a due day, or a note either side keeps. An approved proposal is applied as the scheme's next version from its day; a refused one changes nothing. Every end is final, and overdue is a reading of a follow-up's due day, never a status. It restates no operational record: a route's assignment is the route's own.
_Avoid_: Task, case (that is a Ticket), request (that is an Application), assignment notice

**Service Area Assignment**:
The effective-dated relationship that links an existing Service Area to one service provider. Assigning or transferring it changes the relationship and preserves the Service Area itself.
_Avoid_: Contract area assignment, create service area, service provider area

## Intelligence and automation

**Sustainability Report**:
One Customer's collected waste over a window, by site and fraction. Each stop's kilograms say how they were weighed: measured, apportioned from its route's Unloads, estimated, or unmeasured (counted, never zero). The report also gives the recycling rate and the CO₂e emitted and avoided. It is a reading of the stops and the Emission Factors, and stores nothing.
_Avoid_: Carbon report, ESG report, tonnage report

**Insight**:
A governed analytical finding grounded in traceable operational data.
_Avoid_: Alert, automated action

**Suggestion**:
A proposed action that has not been approved or executed.
_Avoid_: Action, approval

**Approval**:
An explicit decision that authorizes or rejects a controlled change.
_Avoid_: Suggestion, execution
