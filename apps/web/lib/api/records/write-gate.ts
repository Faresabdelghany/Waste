// When a write goes out on the Pilot (Issues #239, #210, #243). In fixture
// mode, and to a module on fixtures, to the browser's bucket at once. To a
// switched module only once the API has read it: before that — still
// loading, its load failed, or the role does not view it — the store refuses
// it (`writeRouteOf`), since the browser's bucket is never shown for a
// switched module. The workspace's own doors — a generic form's create or
// edit, a governed action — hold such a write by the same rule before they
// act (`writeGate`: a governed action records its audit event and says it
// was done, a scheme's edit asks its policy, before any answer), and an edit
// only of a row the API holds: one shown while the module loaded has no
// server id, and would go out as a create. A held write keeps its dialog
// open and says why; one let out is reported once the API has answered
// (`whenSaved`), and one that throws instead of answering is a refusal
// (`answered`), so the dialog waiting on it is freed.
import { UNREACHABLE_STATUS } from "../client"
import { genericProblem, type Problem } from "../problem"
import { IDLE, refusalProblem, type ModuleState, type WriteOutcome } from "./server-records"

export type WriteGate = { kind: "write" } | { kind: "held"; description: string }

/**
 * Whether a write to `target` (null for a module on fixtures) goes out:
 * `label` names the module, `when` what the person can do once it is read,
 * `editing` the row an edit changes.
 */
export function writeGate({ apiConfigured, target, label, when, editing }: { apiConfigured: boolean; target: ModuleState | null; label: string; when: string; editing?: { id: string; name: string } }): WriteGate {
  if (!apiConfigured || target === null) return { kind: "write" }
  const unread = unreadModule(target, label, when)
  if (unread !== null) return { kind: "held", description: unread }
  if (editing !== undefined && !target.serverIds.has(editing.id)) {
    return { kind: "held", description: `${editing.name} is not a row the API holds; close the form and open it again from the list.` }
  }
  return { kind: "write" }
}

/** Why a write to a switched module cannot go out yet — `label` names it, `when` what the person can do once it is read — or null once the API has read it. */
function unreadModule(target: ModuleState, label: string, when: string): string | null {
  switch (target.status) {
    case "ready":
      return null
    case "failed":
      return `${label} could not be read from the API; reload the page to try again.`
    case "not-granted":
      return `Your role does not view ${label}.`
    case "idle":
    case "loading":
      return `${label} is being read from the API; ${when} once it is.`
  }
}

/** The problem a write is refused with once the session it began in is over. */
export const sessionEnded = (): Problem => genericProblem(UNREACHABLE_STATUS, "The session ended before the record was saved")

/** Where the store sends a write: the browser's bucket, the API, or nowhere, with why and whether the store says so. */
export type WriteRoute = { kind: "browser" } | { kind: "api" } | { kind: "refused"; problem: Problem; said: boolean }

/**
 * Where the store sends a write (#243), whoever asks for it: the browser's
 * bucket in fixture mode and for a module on fixtures; the API for a
 * switched module it has read (`target`, undefined for one never asked for)
 * while someone is signed in; else nowhere — refused in the words the
 * workspace's gate says, never kept in the browser, where a switched module
 * would not show it. A write to a module the role does not view comes only
 * from another write's sync (no pane of it is shown): it is refused unsaid,
 * as the person saw nothing of it before.
 */
export function writeRouteOf({ apiConfigured, switched, target, signedIn, label }: { apiConfigured: boolean; switched: boolean; target: ModuleState | undefined; signedIn: boolean; label: string }): WriteRoute {
  if (!apiConfigured || !switched) return { kind: "browser" }
  if (!signedIn) return { kind: "refused", problem: sessionEnded(), said: true }
  const state = target ?? IDLE
  const unread = unreadModule(state, label, "it can be saved")
  if (unread !== null) return { kind: "refused", problem: genericProblem(UNREACHABLE_STATUS, unread), said: state.status !== "not-granted" }
  return { kind: "api" }
}

/** A write's outcome that always answers: a write that throws instead (a mapping fault, a store fault) is a refusal, and `fault` says so — the store said nothing. */
export function answered(outcome: Promise<WriteOutcome> | undefined, recordId: string, fault: () => void): Promise<WriteOutcome> | undefined {
  return outcome?.catch((): WriteOutcome => {
    fault()
    return { kind: "refused", recordId, problem: refusalProblem({ path: "", message: "The write did not complete" }) }
  })
}
