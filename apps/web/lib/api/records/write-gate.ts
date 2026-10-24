// When the workspace's own writes go out on the Pilot (Issues #239, #210): a
// generic form's create or edit and a governed action. In fixture mode, and
// to a module on fixtures, at once. To a switched module only once the API
// has read it: before that — still loading, its load failed, or the role
// does not view it — the store would keep the write in the browser, which a
// switched module never shows, and the workspace would say it was saved. An
// edit goes out only for a row the API holds: one shown while the module
// loaded has no server id, and would go out as a create. A held write keeps
// its dialog open and says why; one let out is reported once the API has
// answered (`whenSaved`), and one that throws instead of answering is a
// refusal (`answered`), so the dialog waiting on it is freed.
import { refusalProblem, type ModuleState, type WriteOutcome } from "./server-records"

export type WriteGate = { kind: "write" } | { kind: "held"; description: string }

/**
 * Whether a write to `target` (null for a module on fixtures) goes out:
 * `label` names the module, `when` what the person can do once it is read,
 * `editing` the row an edit changes.
 */
export function writeGate({ apiConfigured, target, label, when, editing }: { apiConfigured: boolean; target: ModuleState | null; label: string; when: string; editing?: { id: string; name: string } }): WriteGate {
  if (!apiConfigured || target === null) return { kind: "write" }
  switch (target.status) {
    case "ready":
      if (editing !== undefined && !target.serverIds.has(editing.id)) {
        return { kind: "held", description: `${editing.name} is not a row the API holds; close the form and open it again from the list.` }
      }
      return { kind: "write" }
    case "failed":
      return { kind: "held", description: `${label} could not be read from the API; reload the page to try again.` }
    case "not-granted":
      return { kind: "held", description: `Your role does not view ${label}.` }
    case "idle":
    case "loading":
      return { kind: "held", description: `${label} is being read from the API; ${when} once it is.` }
  }
}

/** A write's outcome that always answers: a write that throws instead (a mapping fault, a store fault) is a refusal, and `fault` says so — the store said nothing. */
export function answered(outcome: Promise<WriteOutcome> | undefined, recordId: string, fault: () => void): Promise<WriteOutcome> | undefined {
  return outcome?.catch((): WriteOutcome => {
    fault()
    return { kind: "refused", recordId, problem: refusalProblem({ path: "", message: "The write did not complete" }) }
  })
}
