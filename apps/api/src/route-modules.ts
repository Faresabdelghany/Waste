// Every route module, in the order the app mounts them at its root: a module
// is added here and nowhere else. Each takes the app's deps (deps.ts) and
// declares its operations (operation.ts). Hono runs the handlers of a path in
// registration order, so a static segment goes on before a parameter that
// would catch it — `/routes/live` before `/routes/:id` — which the app's
// tests hold for every pair.
import type { RouteDeps } from "./deps"
import type { Routes } from "./operation"
import { accessCredentialRoutes } from "./routes/access-credentials"
import { addressRoutes } from "./routes/addresses"
import { agreementRoutes } from "./routes/agreements"
import { alertRoutes } from "./routes/alerts"
import { applicationRoutes } from "./routes/applications"
import { auditEventRoutes } from "./routes/audit-events"
import { availabilityRoutes } from "./routes/availability"
import { billableEventRoutes } from "./routes/billable-events"
import { billingRunRoutes } from "./routes/billing-runs"
import { bulkyBookingRoutes } from "./routes/bulky-bookings"
import { bulkyScheduleRoutes } from "./routes/bulky-schedules"
import { catalogueRoutes } from "./routes/catalogue"
import { collectionCalendarRoutes } from "./routes/collection-calendars"
import { collectionGroupRoutes } from "./routes/collection-groups"
import { companyRoutes } from "./routes/company"
import { containerRoutes } from "./routes/containers"
import { contaminantCodeRoutes } from "./routes/contaminant-codes"
import { countingRuleRoutes } from "./routes/counting-rules"
import { customerContactRoutes } from "./routes/customer-contacts"
import { customerRoutes } from "./routes/customers"
import { decommissionReasonRoutes } from "./routes/decommission-reasons"
import { depotRoutes } from "./routes/depots"
import { driverDoorRoutes } from "./routes/driver"
import { driverRoutes } from "./routes/drivers"
import { dropOffPointRoutes } from "./routes/drop-off-points"
import { fieldInspectionRoutes } from "./routes/field-inspections"
import { generationRoutes } from "./routes/generation"
import { holidayListRoutes } from "./routes/holiday-lists"
import { importRoutes } from "./routes/imports"
import { integrationRoutes } from "./routes/integrations"
import { invoiceRoutes } from "./routes/invoices"
import { lifecycleRoutes } from "./routes/lifecycle"
import { liveRoutes } from "./routes/live"
import { maintenanceRoutes } from "./routes/maintenance"
import { meRoutes } from "./routes/me"
import { messageTemplateRoutes } from "./routes/message-templates"
import { messageRoutes } from "./routes/messages"
import { moveRoutes } from "./routes/moves"
import { notificationRuleRoutes } from "./routes/notification-rules"
import { notificationRoutes } from "./routes/notifications"
import { outboundLoadRoutes } from "./routes/outbound-loads"
import { paymentRoutes } from "./routes/payments"
import { pickupExceptionRoutes } from "./routes/pickup-exceptions"
import { pickupRoutes } from "./routes/pickups"
import { planningAreaRoutes } from "./routes/planning-areas"
import { planRoutes } from "./routes/plans"
import { positionRoutes } from "./routes/positions"
import { priceListRoutes } from "./routes/price-lists"
import { productRoutes } from "./routes/products"
import { projectRoutes } from "./routes/projects"
import { proofObjectRoutes } from "./routes/proof-objects"
import { propertyRoutes } from "./routes/properties"
import { propertyGroupRoutes } from "./routes/property-groups"
import { publicRoutes } from "./routes/public"
import { reportRoutes } from "./routes/reports"
import { rightSizingRoutes } from "./routes/right-sizing"
import { roleRoutes } from "./routes/roles"
import { routeBalanceRoutes } from "./routes/route-balance"
import { routeMessageRoutes } from "./routes/route-messages"
import { routeSchemeRoutes } from "./routes/route-schemes"
import { routeRoutes } from "./routes/routes"
import { routingPreviewRoutes } from "./routes/routing-preview"
import { routingQuotaRoutes } from "./routes/routing-quota"
import { scaleHouseRoutes } from "./routes/scale-house"
import { schemeLifecycleRoutes } from "./routes/scheme-lifecycle"
import { sensorRoutes } from "./routes/sensors"
import { serviceAreaRoutes } from "./routes/service-areas"
import { serviceProviderActivityRoutes } from "./routes/service-provider-activities"
import { serviceProviderPriceRoutes } from "./routes/service-provider-prices"
import { serviceProviderRoutes } from "./routes/service-providers"
import { settlementRoutes } from "./routes/settlements"
import { sharedCollectionPointRoutes } from "./routes/shared-collection-points"
import { siteVisitRoutes } from "./routes/site-visits"
import { stockBalanceRoutes } from "./routes/stock-balances"
import { stopMoveRoutes } from "./routes/stop-moves"
import { subscriptionPauseRoutes } from "./routes/subscription-pauses"
import { tankRoutes } from "./routes/tanks"
import { ticketChargeRoutes } from "./routes/ticket-charges"
import { ticketSlaRoutes } from "./routes/ticket-sla"
import { ticketTeamRoutes } from "./routes/ticket-teams"
import { ticketTypeRoutes } from "./routes/ticket-types"
import { ticketRoutes } from "./routes/tickets"
import { unloadingStationRoutes } from "./routes/unloading-stations"
import { unloadRoutes } from "./routes/unloads"
import { userRoutes } from "./routes/users"
import { vehicleAllocationRoutes } from "./routes/vehicle-allocations"
import { vehicleTypeRoutes } from "./routes/vehicle-types"
import { vehicleRoutes } from "./routes/vehicles"
import { visitRuleRoutes } from "./routes/visit-rules"
import { warehouseRoutes } from "./routes/warehouses"
import { weighbridgeRoutes } from "./routes/weighbridge"
import { weightControlRoutes } from "./routes/weight-control"

export const ROUTE_MODULES: readonly ((deps: RouteDeps) => Routes)[] = [
  meRoutes,
  notificationRoutes,
  notificationRuleRoutes,
  companyRoutes,
  projectRoutes,
  serviceProviderRoutes,
  userRoutes,
  roleRoutes,
  auditEventRoutes,
  catalogueRoutes,
  productRoutes,
  customerRoutes,
  customerContactRoutes,
  tankRoutes,
  messageTemplateRoutes,
  messageRoutes,
  addressRoutes,
  propertyRoutes,
  propertyGroupRoutes,
  sharedCollectionPointRoutes,
  agreementRoutes,
  moveRoutes,
  applicationRoutes,
  subscriptionPauseRoutes,
  containerRoutes,
  lifecycleRoutes,
  planningAreaRoutes,
  collectionCalendarRoutes,
  holidayListRoutes,
  routeSchemeRoutes,
  schemeLifecycleRoutes,
  serviceProviderActivityRoutes,
  collectionGroupRoutes,
  generationRoutes,
  vehicleTypeRoutes,
  warehouseRoutes,
  stockBalanceRoutes,
  depotRoutes,
  dropOffPointRoutes,
  unloadingStationRoutes,
  vehicleAllocationRoutes,
  vehicleRoutes,
  driverRoutes,
  availabilityRoutes,
  maintenanceRoutes,
  liveRoutes,
  positionRoutes,
  routeRoutes,
  planRoutes,
  routingQuotaRoutes,
  integrationRoutes,
  routingPreviewRoutes,
  pickupRoutes,
  stopMoveRoutes,
  routeBalanceRoutes,
  proofObjectRoutes,
  unloadRoutes,
  weighbridgeRoutes,
  driverDoorRoutes,
  ticketRoutes,
  ticketSlaRoutes,
  routeMessageRoutes,
  ticketTeamRoutes,
  ticketTypeRoutes,
  countingRuleRoutes,
  contaminantCodeRoutes,
  decommissionReasonRoutes,
  sensorRoutes,
  scaleHouseRoutes,
  outboundLoadRoutes,
  pickupExceptionRoutes,
  bulkyScheduleRoutes,
  bulkyBookingRoutes,
  accessCredentialRoutes,
  siteVisitRoutes,
  visitRuleRoutes,
  fieldInspectionRoutes,
  rightSizingRoutes,
  publicRoutes,
  alertRoutes,
  priceListRoutes,
  serviceAreaRoutes,
  serviceProviderPriceRoutes,
  billableEventRoutes,
  ticketChargeRoutes,
  billingRunRoutes,
  invoiceRoutes,
  paymentRoutes,
  settlementRoutes,
  weightControlRoutes,
  reportRoutes,
  importRoutes,
]
