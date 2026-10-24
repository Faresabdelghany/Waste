// What a stop is for, as a person reads it (O3 of #290): an emptying of its
// container, generation's only service, or one of the office's work orders.
// The office books an emptying, a repair or a wash on a stop it adds
// (`OFFICE_STOP_SERVICES`); the stop's details and the Driver App's card say
// which.
import type { PickupService } from "@waste/contracts/execution"
import { OFFICE_STOP_SERVICES } from "@waste/domain/execution/vocabulary"

export const PICKUP_SERVICE_LABELS: Readonly<Record<PickupService, string>> = {
  empty: "Emptying",
  deliver: "Delivery",
  remove: "Removal",
  swap: "Swap",
  repair: "Repair",
  wash: "Wash",
}

/** What an office stop may be booked as, for the Add stop form. */
export const OFFICE_STOP_SERVICE_OPTIONS = OFFICE_STOP_SERVICES.map((service) => ({ value: service, label: PICKUP_SERVICE_LABELS[service] }))

/** What a repair or a wash at an address alone is told, before the API would say it: the contracts' `A_WORK_ORDER_OF_A_CONTAINER`, spelled again so no zod reaches the browser, and held equal to it by a test. */
export const A_WORK_ORDER_IS_OF_A_CONTAINER = "A repair or a wash is of a container: name the container"
