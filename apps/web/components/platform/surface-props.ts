// What a module's command surfaces are handed (components/waste/commands/command-surfaces.ts):
// a primary surface its action's label, a row surface the row whose details are open.
import type { BusinessRecord } from "@/lib/data/business-modules"

export type PrimarySurfaceProps = { label: string }

export type RowSurfaceProps = { record: BusinessRecord }
