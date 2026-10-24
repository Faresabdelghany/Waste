// When the workspace's own writes go out on the Pilot (Issues #239, #210): a
// generic form's create or edit and a governed action. In fixture mode, and
// to a module on fixtures, at once. To a switched module only once the API
// has read it: before that — still loading, or its load failed — the store
// would keep the write in the browser, which a switched module never shows,
// and the workspace would say it was saved. A held write keeps its dialog
// open and says when it can go; one let out is reported once the API has
// answered (`whenSaved`).
import type { ModuleState } from "./server-records"

export type WriteGate = { kind: "write" } | { kind: "held"; description: string }

/** Whether a write to `target` (null for a module on fixtures) goes out; `label` names the module, `when` what the person can do once it is read. */
export function writeGate(apiConfigured: boolean, target: ModuleState | null, label: string, when: string): WriteGate {
  if (!apiConfigured || target === null || target.status === "ready") return { kind: "write" }
  return { kind: "held", description: `${label} are not read from the API yet; ${when} once they are.` }
}
