// The pickup's spellings 0032 (O3b of #290) gave it, which execution-rendering
// and stop-ledger-rendering both read: the generated reserved and taken
// containers, and the three shapes holding each booking to its service.
import { ref } from "./rendering"

/** The reserved container as drizzle-kit spells the generated column: a planned delivery's own, a planned swap's replacement. */
export const RESERVED_CONTAINER = `case when "status" = 'planned' then case "service" when 'deliver' then "container_id" when 'swap' then "replacement_container_id" end end`

/** The taken container as drizzle-kit spells the generated column: a planned removal's or swap's own. */
export const TAKEN_CONTAINER = `case when "status" = 'planned' and "service" in ('remove', 'swap') then "container_id" end`

/** What each service books, and nothing else books it. */
export const BOOKED_SHAPES = [
  `CONSTRAINT "pickup_subscription_shape" CHECK ((${ref("pickup", "service")} = 'deliver') = (${ref("pickup", "subscription_id")} is not null))`,
  `CONSTRAINT "pickup_warehouse_shape" CHECK ((${ref("pickup", "service")} in ('remove', 'swap')) = (${ref("pickup", "warehouse_id")} is not null))`,
  `CONSTRAINT "pickup_replacement_shape" CHECK ((${ref("pickup", "service")} = 'swap') = (${ref("pickup", "replacement_container_id")} is not null) and (${ref("pickup", "replacement_container_id")} is null or ${ref("pickup", "replacement_container_id")} <> ${ref("pickup", "container_id")}))`,
]
