// The Sorting Guide (Issue #293, M1): what a resident looks up to learn where
// a thing goes. One row per item a project's guide knows — "Pizzabakke",
// "Batterier" — with the other words it is known by, the waste fraction it
// belongs to where it has one (a battery goes to a drop-off point, not a bin,
// and its fraction is null until the drop-off points of M3 can be named), and
// how to present it. The office writes the rows; the public door reads the
// published ones of a project that publishes itself (ADR-0010), with SELECT
// on exactly the columns `PUBLIC_DOOR_TABLES` names (src/sql/public-door.ts).
//
// The search runs over the rows in memory (`@waste/domain/sorting-guide/search`),
// so there is no trigram index: a guide holds hundreds of items, not millions.
import { SORTING_GUIDE_ITEM_STATUSES } from "@waste/domain/sorting-guide/vocabulary"
import { sql } from "drizzle-orm"
import { text, uuid } from "drizzle-orm/pg-core"

import { wasteFraction } from "./catalogue"
import { oneOf } from "./checks"
import { id, projectScoped, timestamps } from "./columns"
import { company, project } from "./organisation"
import { companyReference, projectKey, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const sortingGuideItem = wms.table(
  "sorting_guide_item",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** What the resident searches for and reads first: `Pizzabakke`. Unique per project. */
    name: text().notNull(),
    /** The other words the item is known by, searched like the name: `pizza box`, `pizzaæske`. */
    synonyms: text().array().notNull().default(sql`'{}'::text[]`),
    /** The fraction it is sorted into; null where it belongs to no collected fraction. */
    wasteFractionId: uuid(),
    /** How to present it: rinsed, flattened, lid off. */
    instructions: text(),
    status: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    oneOf(t.status, SORTING_GUIDE_ITEM_STATUSES),
    tenantIndex(t, t.wasteFractionId),
  ],
)
