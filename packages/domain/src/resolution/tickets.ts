// What a Ticket's bodies hold to at the boundary, in the words a refusal
// says: the rules the table's checks hold too — a pickup names its route, a
// re-collection's route and stop go with `recollected`, a product with a
// resolution Finance charges for — and the bounds of what a body carries.
import { BILLABLE_RESOLUTIONS } from "./vocabulary"

/** What a ticket whose label is not its number is told. */
export const LABEL_IS_THE_NUMBER = "label is the number under the ticket prefix"

/** What a body naming a pickup without its route is told. */
export const PICKUP_WITH_ITS_ROUTE = "Name the pickup's route with the pickup"

/** A pickup names its route: the table's `ticket_pickup_shape`, over a body that carries the whole picture. */
export const pickupWithItsRoute = (links: { routeId?: string | null; pickupId?: string | null } | undefined): boolean => links === undefined || links.pickupId == null || links.routeId != null

/** The pickup rule on a patch, where only both halves in the body are judged: a body moving `pickupId` alone names the stored route, and the route holds it. */
export const pickupWithItsRouteOnPatch = (links: { routeId?: string | null; pickupId?: string | null } | undefined): boolean => links === undefined || links.pickupId == null || links.routeId !== null

/** What a create naming neither a type nor a kind is told. */
export const TYPE_OR_KIND = "Name the ticket's type, or its kind for the kind's default type"

/** What a completion naming a re-collection route with another resolution is told. */
export const RECOLLECTION_ROUTE_WITH_RECOLLECTED = "Name the re-collection's route with recollected and with nothing else"

/** The re-collection's route goes with `recollected`: the table's `ticket_recollection_shape`. */
export const recollectionRouteWithRecollected = (body: { resolution?: string; recollectionRouteId?: string }): boolean => body.recollectionRouteId === undefined || body.resolution === "recollected"

/** What a completion naming a re-collection stop without its route is told. */
export const RECOLLECTION_STOP_WITH_ITS_ROUTE = "Name the re-collection's stop with the route it is a stop of"

/** The re-collection's stop goes with its route (#111): the table's `ticket_recollection_pickup_shape`. */
export const recollectionStopWithItsRoute = (body: { recollectionRouteId?: string; recollectionPickupId?: string }): boolean => body.recollectionPickupId === undefined || body.recollectionRouteId !== undefined

/** What a completion naming a product with a resolution nothing is charged for is told. */
export const CHARGE_WITH_A_BILLABLE_RESOLUTION = "Only a re-collection or a service is charged; name a product with recollected or serviced"

/** The product goes with a resolution Finance charges for (#291 C3): the table's `ticket_charge_shape`. */
export const chargeWithABillableResolution = (body: { resolution: string; productId?: string }): boolean => body.productId === undefined || (BILLABLE_RESOLUTIONS as readonly string[]).includes(body.resolution)

/** What a project's charges naming a kind or a type twice are told. */
export const KIND_CHARGED_ONCE = "Each ticket kind or type is charged at one product; name each once"

/** The office's note after the record's reply: bounded so the two, a blank line between, fit a comment's paragraph. */
export const REPLY_NOTE_MAX = 1500
