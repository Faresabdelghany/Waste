// The command surfaces (Issue #181): how a module switched onto the API is
// operated on the Pilot beyond its own create and edit forms. A status the
// wire moves only by command (a container's asset state, an allocation's
// status) is never an edit, so the module's rows offer their commands here —
// in their details, through the store's `sendCommand` — and a module whose
// create is a command of its own, or which the wire only reads, says so in
// place of the primary action its fixture form had.
//
// The workspace consults this registry in four places — the primary action,
// the details' actions, `whileShown`, mounted beside the module's table
// while the module is shown on the Pilot, for what a module does on its own
// while a person watches it (the Live board's re-read), and `list`, which of
// the module's records are its rows and how they are filtered: the shape a
// module of two shapes lists (#185: the price rows, never their lists), the
// toolbar's categories read off a row for the person looking, and the filters
// the module opens with (#147: tickets open on the open ones) — and only
// while the adapter is configured and the
// module is switched (`commandSurfaceFor`): fixture mode never reaches it,
// and the fixture forms and filters stand exactly as before. A later slice
// adds its module here rather than another branch in business-workspace.tsx;
// every key is a `SERVER_MODULES` key
// (lib/api/__tests__/command-surfaces.test.ts).
import type { ComponentType } from "react"

import { AlertCommandsSurface, NewTicketSurface, RaiseAlertSurface } from "@/components/tickets/resolution-surfaces"
import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"
import { moduleKeyOf } from "@/lib/api/records/adapter"
import { isServerBacked } from "@/lib/api/records/modules"
import { ALERT_LIST_INITIAL, alertListReaders } from "@/lib/data/alerts"
import { applicationCorrectable } from "@/lib/data/applications"
import { isTeamMember } from "@/lib/data/provider-workspace"
import { TICKET_LIST_INITIAL, ticketListReaders } from "@/lib/data/tickets"
import { emptyBusinessFilters, singleFilterValue, type BusinessFilters, type FilterValueReaders } from "@waste/domain/business-filters"

import { AgreementCommandsSurface } from "./agreement-surfaces"
import { ActivityCommandsSurface, LogActivitySurface } from "./activity-surfaces"
import { ApplicationCommandsSurface } from "./application-surfaces"
import { BookBulkySurface, BulkyBookingCommandsSurface } from "./bulky-surfaces"
import { CredentialCommandsSurface, RegisterCredentialSurface, SiteVisitCommandsSurface, SiteVisitsPrimarySurface } from "./site-visit-surfaces"
import { AllocateSurface, AllocationCommandsSurface } from "./allocation-surfaces"
import { DriverAbsenceSurface } from "./availability-surfaces"
import { VehicleRowSurface } from "./compartment-surfaces"
import { AddManualEventSurface, BillingRunSurface, EventCommandsSurface, InvoiceSurface, RunBillingSurface } from "./billing-surfaces"
import { BILLING_LIST, EVENTS_LIST, INVOICES_LIST, PAYMENTS_LIST, PRICE_ROWS_LIST } from "./commercial-lists"
import { AddContainerSurface, ContainerCommandsSurface } from "./container-surfaces"
import { CustomerCommandsSurface } from "./customer-surfaces"
import { PaymentCommandsSurface, PaymentsPrimarySurface } from "./payment-surfaces"
import { AccountingExportSurface, ExportPeriodSurface } from "./accounting-surfaces"
import { AddPropertyGroupSurface, AddPropertySurface, AddSharedPointSurface, PropertyCommandsSurface, PropertyGroupCommandsSurface, SharedPointCommandsSurface } from "./place-surfaces"
import { PriceRowCommandsSurface, PriceRowsPrimarySurface, ProductCommandsSurface, ProductsPrimarySurface } from "./pricing-surfaces"
import { PROVIDER_PRICES_LIST, SERVICE_AREAS_LIST, SETTLEMENTS_LIST, WEIGHTS_LIST } from "./provider-money-lists"
import { CreateServiceAreaSurface, OpenSettlementSurface, ProviderPriceCommandsSurface, ProviderPricesPrimarySurface, RecordUnloadSurface, ServiceAreaCommandsSurface, ServiceAreasRead, SettlementSurface, WeightReviewSurface } from "./provider-money-surfaces"
import { InviteTeamMemberSurface, TeamMemberCommandsSurface } from "./team-surfaces"
import { LiveBoardRefresh, LiveRouteSurface, PickupCommandsSurface, RouteCommandsSurface, RoutesPrimarySurface } from "./route-surfaces"

/** What a primary surface is handed: the label the module's primary action carries. */
export type PrimarySurfaceProps = { label: string }

/** What a row surface is handed: the row whose details are open. */
export type RowSurfaceProps = { record: BusinessRecord }

export type CommandSurface = {
  /**
   * What stands in for the module's primary action on the Pilot: its own
   * create form (`"form"`, the create going through the adapter as ever), a
   * dialog of the module's own, or nothing, for a module the wire only reads.
   * A dialog of the module's own is offered with the create grant alone,
   * whatever the fixture form (#186: Settlements' is disabled); the form,
   * where the module's fixture form offers one (`primaryOf`).
   */
  primary: "form" | ComponentType<PrimarySurfaceProps> | null
  /** The row's commands, and what they read (a ledger, a history), in its details. */
  rowActions?: ComponentType<RowSurfaceProps>
  /**
   * Whether the row keeps the generic Edit beside its surface: a surface
   * changes the row otherwise, so the workspace offers no Edit (#179). The
   * fleet's (O6 of #290) add what the row is away for and change nothing the
   * form holds. A rule keeps it for the rows it holds for alone, offered in
   * the row's details, where the row is known (M7 of #293: an Application
   * while undecided, `genericEditOffered`).
   */
  genericEdit?: true | ((record: BusinessRecord) => boolean)
  /** Mounted beside the module's table while the module is shown, rendering nothing itself: the Live board's re-read. */
  whileShown?: ComponentType
  /** Which of the module's records are its rows on the Pilot, and how they are filtered, in place of the workspace's own per-module matching. */
  list?: ModuleList
}

/** Who is looking at a list: the account `/me` answered, null until it has — what a reader that says "Mine" compares with. */
export type ListViewer = { accountId: string | null }

/**
 * A module's list on the Pilot. `readers` are its toolbar's categories, in
 * the order offered, each reading a row's values for the person looking —
 * the popover offers them and the rows are matched through them, so the two
 * never disagree. `initial` is what the module opens with, applied when it
 * becomes the active module and never again while it stays so: a filter the
 * person changed is theirs, whatever loads after. `shows` scopes the
 * module's rows: where a module holds records of two shapes, the one it
 * lists — the price rows, never the price lists they are filed under (#185)
 * — before any filter, so the count, the filter values and the column
 * options are that shape's alone; one column set over two shapes reads
 * neither.
 */
export type ModuleList = {
  readers: (viewer: ListViewer) => FilterValueReaders
  initial: Partial<BusinessFilters>
  shows?: (record: BusinessRecord) => boolean
}

/** Whether a record is one of a module's rows on the Pilot: every record, unless its list says which (`shows`); the workspace scopes the module by it before any filter. */
export function listShows(list: ModuleList | undefined, record: BusinessRecord): boolean {
  return list?.shows?.(record) ?? true
}

/** Whether a row's details offer the generic Edit by its surface: every row where the surface keeps it, the rows its rule holds for where it names one, and none where it keeps none. */
export function genericEditOffered(surface: CommandSurface | undefined, record: BusinessRecord | null | undefined): boolean {
  if (surface?.genericEdit === true) return true
  return typeof surface?.genericEdit === "function" && record != null && surface.genericEdit(record)
}

/** Which primary action a module offers: its surface's own dialog with the create grant alone, its form where the fixture form offers one (`formOffered`), or none. */
export function primaryOf(surface: CommandSurface | undefined, granted: boolean, formOffered: boolean): "surface" | "form" | null {
  if (!granted) return null
  if (surface !== undefined && surface.primary !== "form") return surface.primary === null ? null : "surface"
  return formOffered ? "form" : null
}

/** The filters a module opens with: its list's `initial` over no filter, or no filter for a module without one (every module in fixture mode). */
export function initialFiltersOf(surface: CommandSurface | undefined): BusinessFilters {
  return { ...emptyBusinessFilters, ...surface?.list?.initial }
}

/** A provider's team: its accounts alone, filtered by where they stand and the role they hold. */
const TEAM_LIST: ModuleList = {
  shows: isTeamMember,
  readers: () => ({ statuses: (record) => [record.status], roles: (record) => singleFilterValue(record.facts.Roles) }),
  initial: {},
}

/** The surfaces, by `workspace.module`. */
export const COMMAND_SURFACES: Readonly<Record<string, CommandSurface>> = {
  // Slice 5b (#181): the identity by its own form, the lifecycle by command.
  "resources.containers": { primary: AddContainerSurface, rowActions: ContainerCommandsSurface },
  // The ledger is read-only on the wire: a movement is a container's command.
  "resources.inventory": { primary: null },
  "fleet.vehicle-planning": { primary: AllocateSurface, rowActions: AllocationCommandsSurface },
  // O6 of #290: a driver's absences and a vehicle's periods out of use, in the row's details; the row itself by its own form as before.
  "fleet.drivers": { primary: "form", rowActions: DriverAbsenceSurface, genericEdit: true },
  "fleet.vehicles": { primary: "form", rowActions: VehicleRowSurface, genericEdit: true },
  // Slice 9b (#184): each place by its own form, its set replaced whole by its Edit; the status by the lifecycle's actions.
  "customers.properties": { primary: AddPropertySurface, rowActions: PropertyCommandsSurface },
  "customers.groups": { primary: AddPropertyGroupSurface, rowActions: PropertyGroupCommandsSurface },
  "customers.shared": { primary: AddSharedPointSurface, rowActions: SharedPointCommandsSurface },
  // Slice 10 of #291: an agreement and a subscription by their forms, as ever; their lifecycle — a termination, a change of service, a pause — by command.
  "customers.agreements": { primary: "form", rowActions: AgreementCommandsSurface },
  // M7 of #293: an Application recorded and corrected by its own form while undecided, moved by its commands, its Decisions and letter in its details.
  "customers.applications": { primary: "form", rowActions: ApplicationCommandsSurface, genericEdit: applicationCorrectable },
  // #474: an Activity opened by its side's own form, closed by its commands and corrected by its own form while open; the registry's form stays disabled.
  "service-providers.activities": { primary: LogActivitySurface, rowActions: ActivityCommandsSurface },
  // Slice 6 (#179): generation writes routes and their stops; a route and a
  // stop move by their commands, and the Live board only reads. A route's
  // details are these, not the fixture route page. #111: New route makes the
  // office's ad-hoc route, and a route's Add stop the office's stop, so the
  // stops still have no create of their own. O5 of #290: Dispatch day stands
  // beside New route, a project's day of routes dispatched in one request.
  "route-studio.routes": { primary: RoutesPrimarySurface, rowActions: RouteCommandsSurface },
  "route-studio.pickups": { primary: null, rowActions: PickupCommandsSurface },
  "route-studio.live": { primary: null, rowActions: LiveRouteSurface, whileShown: LiveBoardRefresh },
  // Slice 8 (#182, #147): a ticket opened by the office's own form and worked
  // in its own details (TicketDetailsDialog), the list opening on the open
  // ones; an alert raised by hand and moved by its commands, the queue
  // opening on what still needs attention.
  // O11 of #290: a bulky collection booked by its own dialog, its days read from the place's schedule; a booked one routed onto a route of its day or cancelled.
  "operate.bulky-bookings": { primary: BookBulkySurface, rowActions: BulkyBookingCommandsSurface },
  // #393: the attendant's check-in is its own page, with the likely trades beside it; a visit is voided with why, never edited.
  "operate.site-visits": { primary: SiteVisitsPrimarySurface, rowActions: SiteVisitCommandsSurface },
  // #393: a plate or a card registered by its own dialog under its holder; its label and end edited, and blocked or unblocked, in its details.
  "customers.site-access": { primary: RegisterCredentialSurface, rowActions: CredentialCommandsSurface },
  "operate.tickets": { primary: NewTicketSurface, list: { readers: ({ accountId }) => ticketListReaders(accountId), initial: TICKET_LIST_INITIAL } },
  "operate.exceptions": { primary: RaiseAlertSurface, rowActions: AlertCommandsSurface, list: { readers: alertListReaders, initial: ALERT_LIST_INITIAL } },
  // Slice 10 (#185): a product is made in Settings, so both pricing modules'
  // primary is Add price, the price rows' with Explain price beside it; an
  // event moves by its two commands; a run is previewed before it runs; an
  // invoice is read and credited, never edited.
  "commercial.products": { primary: ProductsPrimarySurface, rowActions: ProductCommandsSurface },
  "commercial.price-rows": { primary: PriceRowsPrimarySurface, rowActions: PriceRowCommandsSurface, list: PRICE_ROWS_LIST },
  "commercial.events": { primary: AddManualEventSurface, rowActions: EventCommandsSurface, list: EVENTS_LIST },
  "commercial.billing": { primary: RunBillingSurface, rowActions: BillingRunSurface, list: BILLING_LIST },
  "commercial.invoices": { primary: null, rowActions: InvoiceSurface, list: INVOICES_LIST },
  // Slice 6 (#291 C6): a payment registered by hand or a bank statement's
  // lines imported; a payment matched and its match undone in its details,
  // never edited. A customer's details offer its statement beside its Edit.
  "commercial.payments": { primary: PaymentsPrimarySurface, rowActions: PaymentCommandsSurface, list: PAYMENTS_LIST },
  // The accounting export (#291 C7): Export period previews before it books, and an export's details offer its file.
  "commercial.accounting": { primary: ExportPeriodSurface, rowActions: AccountingExportSurface },
  "customers.contacts": { primary: "form", rowActions: CustomerCommandsSurface, genericEdit: true },
  // Slice 11 (#186): an award by its own form, its assignments in its
  // details; a price's fee moved by Apply index alone; a settlement by the
  // commands its status moves by; an unload by its reviews, the desk's queue
  // first. Weights are written by the Driver App, never the office. The
  // awards are read again where their assignments are listed or picked: an
  // award the map or the provider page made has its first assignment on the
  // server alone.
  "service-providers.service-areas": { primary: CreateServiceAreaSurface, rowActions: ServiceAreaCommandsSurface, list: SERVICE_AREAS_LIST, whileShown: ServiceAreasRead },
  "commercial.service-provider-prices": { primary: ProviderPricesPrimarySurface, rowActions: ProviderPriceCommandsSurface, list: PROVIDER_PRICES_LIST, whileShown: ServiceAreasRead },
  "commercial.settlements": { primary: OpenSettlementSurface, rowActions: SettlementSurface, list: SETTLEMENTS_LIST, whileShown: ServiceAreasRead },
  "route-studio.weights": { primary: RecordUnloadSurface, rowActions: WeightReviewSurface, list: WEIGHTS_LIST },
  // #291 C24: a provider's team invited through its own dialog on a provider's role, a member switched off and on in its details; the module lists the accounts, never the roles it reads beside them.
  "service-providers.service-provider-workspace": { primary: InviteTeamMemberSurface, rowActions: TeamMemberCommandsSurface, list: TEAM_LIST },
}

/** The module's surface while the adapter is configured and the module switched; undefined otherwise, and always in fixture mode. */
export function commandSurfaceFor(workspaceId: WorkspaceId, moduleId: string, configured: boolean): CommandSurface | undefined {
  if (!configured || !isServerBacked(workspaceId, moduleId)) return undefined
  return COMMAND_SURFACES[moduleKeyOf(workspaceId, moduleId)]
}
