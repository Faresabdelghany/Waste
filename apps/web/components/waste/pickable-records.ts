"use client"

// The rows a picker on a switched module's form may offer from another
// module (the plan on #81, "relations by id"): on the Pilot, only a module
// the store reads from the API — one still on fixtures offers nothing until
// it is switched, since a fixture row names nothing the API holds and a
// write naming it would be refused. A value the record already carries stays
// and shows as its id chip. On the browser's path every row is offered, as
// before. The route scheme's fleet, places and containers are the first such
// relations (slice 3); they light up by themselves once slices 5a and 5b
// switch their modules.
import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"
import { isServerBacked } from "@/lib/api/records/modules"

import { useApiConfigured } from "./api-session-store"

/** Whether a picker may offer a module's rows: always on the browser's path, on the Pilot only once the module is read from the API. */
export function offersRowsOf(apiConfigured: boolean, workspaceId: WorkspaceId, moduleId: string): boolean {
  return !apiConfigured || isServerBacked(workspaceId, moduleId)
}

/** A module's rows as a picker may offer them: `records`, or none on the Pilot while the module is on fixtures. */
export function usePickableRecords(workspaceId: WorkspaceId, moduleId: string, records: BusinessRecord[]): BusinessRecord[] {
  return offersRowsOf(useApiConfigured(), workspaceId, moduleId) ? records : NO_RECORDS
}

const NO_RECORDS: BusinessRecord[] = []
