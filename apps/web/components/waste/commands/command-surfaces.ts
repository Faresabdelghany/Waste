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
// while a person watches it (the Live board's re-read), and `list`, how the
// module's rows are filtered: the toolbar's categories read off a row for
// the person looking, and the filters the module opens with (#147: tickets
// open on the open ones) — and only while the adapter is configured and the
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
import { TICKET_LIST_INITIAL, ticketListReaders } from "@/lib/data/tickets"
import { emptyBusinessFilters, type BusinessFilters, type FilterValueReaders } from "@waste/domain/business-filters"

import { AllocateSurface, AllocationCommandsSurface } from "./allocation-surfaces"
import { AddManualEventSurface, BillingRunSurface, EventCommandsSurface, InvoiceSurface, RunBillingSurface } from "./billing-surfaces"
import { BILLING_LIST, EVENTS_LIST, INVOICES_LIST, PRICE_ROWS_LIST } from "./commercial-lists"
import { AddContainerSurface, ContainerCommandsSurface } from "./container-surfaces"
import { AddPropertyGroupSurface, AddPropertySurface, AddSharedPointSurface, PropertyCommandsSurface, PropertyGroupCommandsSurface, SharedPointCommandsSurface } from "./place-surfaces"
import { PriceRowCommandsSurface, PriceRowsPrimarySurface, ProductCommandsSurface, ProductsPrimarySurface } from "./pricing-surfaces"
import { LiveBoardRefresh, LiveRouteSurface, PickupCommandsSurface, RouteCommandsSurface } from "./route-surfaces"

/** What a primary surface is handed: the label the module's primary action carries. */
export type PrimarySurfaceProps = { label: string }

/** What a row surface is handed: the row whose details are open. */
export type RowSurfaceProps = { record: BusinessRecord }

export type CommandSurface = {
  /**
   * What stands in for the module's primary action on the Pilot: its own
   * create form (`"form"`, the create going through the adapter as ever), a
   * dialog of the module's own, or nothing, for a module the wire only reads.
   * It is offered where the module's fixture form offered its primary action
   * (the workspace's own guard: a create grant and a form schema), so a
   * module with no fixture form offers no primary surface either.
   */
  primary: "form" | ComponentType<PrimarySurfaceProps> | null
  /** The row's commands, and what they read (a ledger, a history), in its details. */
  rowActions?: ComponentType<RowSurfaceProps>
  /** Mounted beside the module's table while the module is shown, rendering nothing itself: the Live board's re-read. */
  whileShown?: ComponentType
  /** How the module's rows are filtered on the Pilot, in place of the workspace's own per-module matching. */
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
 * person changed is theirs, whatever loads after. `shows`, where a module
 * holds rows of two shapes, is the one its table lists — the price rows,
 * never the price lists they are filed under (#185) — whatever the filters
 * say, since one column set over two shapes reads neither.
 */
export type ModuleList = {
  readers: (viewer: ListViewer) => FilterValueReaders
  initial: Partial<BusinessFilters>
  shows?: (record: BusinessRecord) => boolean
}

/** Whether a module's list shows a row on the Pilot: every row, unless the list says which (`shows`). */
export function listShows(list: ModuleList | undefined, record: BusinessRecord): boolean {
  return list?.shows?.(record) ?? true
}

/** The filters a module opens with: its list's `initial` over no filter, or no filter for a module without one (every module in fixture mode). */
export function initialFiltersOf(surface: CommandSurface | undefined): BusinessFilters {
  return { ...emptyBusinessFilters, ...surface?.list?.initial }
}

/** The surfaces, by `workspace.module`. */
export const COMMAND_SURFACES: Readonly<Record<string, CommandSurface>> = {
  // Slice 5b (#181): the identity by its own form, the lifecycle by command.
  "resources.containers": { primary: AddContainerSurface, rowActions: ContainerCommandsSurface },
  // The ledger is read-only on the wire: a movement is a container's command.
  "resources.inventory": { primary: null },
  "fleet.vehicle-planning": { primary: AllocateSurface, rowActions: AllocationCommandsSurface },
  // Slice 9b (#184): each place by its own form, its set replaced whole by its Edit; the status by the lifecycle's actions.
  "customers.properties": { primary: AddPropertySurface, rowActions: PropertyCommandsSurface },
  "customers.groups": { primary: AddPropertyGroupSurface, rowActions: PropertyGroupCommandsSurface },
  "customers.shared": { primary: AddSharedPointSurface, rowActions: SharedPointCommandsSurface },
  // Slice 6 (#179): generation writes routes and their stops, so there is no
  // create; a route and a stop move by their commands, and the Live board
  // only reads. A route's details are these, not the fixture route page.
  "route-studio.routes": { primary: null, rowActions: RouteCommandsSurface },
  "route-studio.pickups": { primary: null, rowActions: PickupCommandsSurface },
  "route-studio.live": { primary: null, rowActions: LiveRouteSurface, whileShown: LiveBoardRefresh },
  // Slice 8 (#182, #147): a ticket opened by the office's own form and worked
  // in its own details (TicketDetailsDialog), the list opening on the open
  // ones; an alert raised by hand and moved by its commands, the queue
  // opening on what still needs attention.
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
}

/** The module's surface while the adapter is configured and the module switched; undefined otherwise, and always in fixture mode. */
export function commandSurfaceFor(workspaceId: WorkspaceId, moduleId: string, configured: boolean): CommandSurface | undefined {
  if (!configured || !isServerBacked(workspaceId, moduleId)) return undefined
  return COMMAND_SURFACES[moduleKeyOf(workspaceId, moduleId)]
}
