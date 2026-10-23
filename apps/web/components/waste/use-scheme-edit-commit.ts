"use client"

// The one edit-save of a route scheme (issue #33, D31; the edit policy of
// issue #38), as a hook the workspace calls from both edit doors — the schema
// dialog and the collection groups editor. `commitSchemeEdit` runs the
// lifecycle seam (planSchemeEditReconciliation) over the stored record and
// the edited one against the records as they are NOW, and applies what it
// returns: the scheme, the routes, the pickups, the audit event, the toast.
//
// Under "Ask each time" the planner may answer with a question instead of
// writes. The hook then keeps only the edit itself — `{ before, after, audit,
// onSaved }` and the question — as `pendingSchemeEdit`; the edit dialog stays
// open underneath so "Back to the edit" loses nothing, and the answer goes
// through `answerPendingSchemeEdit`, which calls the CURRENT commit. Nothing
// closes over the records as they were when the question was raised: a Plan
// Ahead run or another tab's write in the seconds the person takes to answer
// is read when the plan is made, not overwritten by a plan made before it.
// A one-off that fails validation is refused whole and the dialog stays open
// on the refusal.
//
// On the Pilot (`schemesOnApi`, slice 3 of #81) the API holds the scheme and
// generates its routes, so none of that runs: the edit is the scheme's alone,
// under the status the wire has — the web's validation never lowers a
// validated scheme, the API's 409 speaking for one the edit breaks, and a
// Draft the edit leaves without a blocking issue asks to be validated, the
// browser path's rule (`schemeEditStatusOnApi`) — and the next generation
// run reconciles its routes. The dialog closes once the API has taken the
// edit. The question returns there with the routes on the API (#179): the
// same rule over the routes the API holds (`schemeEditOnApi`), with "This
// collection only" shown and not offered, since the API keeps no one-off yet
// (#209), and a stored one-off refused; "Apply to future collections" saves
// the scheme, and its planned routes follow it when its routes are next
// generated. Until the routes module has read the API's routes, an edit that
// would ask is refused, since how it applies cannot be asked.

import { useCallback, useState, type Dispatch, type SetStateAction } from "react"
import { toast } from "sonner"

import { useBusinessRecordStore, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import { useContainersPlaced } from "@/components/waste/use-containers-placed"
import type { WriteOutcome } from "@/lib/api/records/server-records"
import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"
import { projectToday, schemeEditOnApi, schemeEditStatusOnApi, timezoneOfProject, validationWhenUnplaced, type SchemeOneOff } from "@/lib/data/route-schemes"
import {
  planSchemeEditReconciliation,
  type SchemeEditApplication,
  type SchemeEditQuestion,
} from "@waste/domain/route-schemes/edit"
import { schemeLiveValidation } from "@waste/domain/route-schemes/lifecycle"
import { formatServiceDate, todayIso } from "@waste/domain/route-schemes/recurrence"
import { count } from "@waste/domain/text"

/** What the save writes to the scheme's audit trail besides what the planner decides: the event's id, action and reason, and the evidence line read off the saved scheme. */
export type SchemeEditAudit = {
  id: string
  action: string
  reason: string
  evidence: (scheme: BusinessRecord) => string
}

/** The workspace's per-record audit event (the shape business-workspace.tsx keeps), spelled here so the hook does not reach into the workspace. */
export type SchemeEditAuditEvent = {
  id: string
  action: string
  actor: string
  at: string
  reason: string
  before: string
  after: string
  evidence: string
}

/**
 * A scheme edit the planner answered with a question (issue #38): the edit
 * as it was submitted, kept until the person answers or goes back, and the
 * question to show. Deliberately no callback that plans — the answer plans
 * again through the current `commitSchemeEdit`.
 */
export type PendingSchemeEdit = {
  before: BusinessRecord
  after: BusinessRecord
  audit: SchemeEditAudit
  onSaved: (scheme: BusinessRecord) => void
  question: SchemeEditQuestion
}

export type SchemeEditCommitDeps = {
  /** The live records of any workspace module — what the planner reads its related records from, at plan time. */
  moduleRecords: (workspaceId: WorkspaceId, moduleId: string) => BusinessRecord[]
  upsertRecord: (workspaceId: WorkspaceId, moduleId: string, record: BusinessRecord) => Promise<WriteOutcome> | undefined
  setAuditEvents: Dispatch<SetStateAction<Record<string, SchemeEditAuditEvent[]>>>
  /** The workspace's selected record: refreshed when it is the scheme just saved. */
  setSelectedRecord: Dispatch<SetStateAction<BusinessRecord | null>>
  actorName: string
  /** The Pilot: the API holds the schemes, so an edit writes the scheme alone (the header). */
  schemesOnApi: boolean
}

export function useSchemeEditCommit({
  moduleRecords,
  upsertRecord,
  setAuditEvents,
  setSelectedRecord,
  actorName,
  schemesOnApi,
}: SchemeEditCommitDeps) {
  const [pendingSchemeEdit, setPendingSchemeEdit] = useState<PendingSchemeEdit | null>(null)
  // The API's routes, once the routes module has read them; null before, or when the read failed.
  const routesState = useServerModuleState("route-studio", "routes")
  const apiRoutes = routesState?.status === "ready" ? routesState.records : null
  const containersPlaced = useContainersPlaced()
  const { sendCommand } = useBusinessRecordStore()

  /**
   * "This collection only" on the Pilot (#209): the scheme's rename or policy
   * first, then each route's command in turn, the API holding every route it
   * moves against later generation runs. A refusal stops the run, the store
   * having told it in the API's words; what moved before it stays moved.
   */
  const moveOneOff = useCallback(
    async (before: BusinessRecord, oneOff: SchemeOneOff, audit: SchemeEditAudit, onSaved: (scheme: BusinessRecord) => void) => {
      const scheme = oneOff.scheme ?? before
      if (oneOff.scheme !== null && (await upsertRecord("route-studio", "schemes", oneOff.scheme))?.kind === "refused") return
      const routes = new Set(oneOff.moves.map((move) => move.routeId))
      const moved = new Set<string>()
      for (const move of oneOff.moves) {
        if ((await sendCommand("route-studio", "routes", move.routeId, move.command, move.input)).kind === "refused") break
        moved.add(move.routeId)
      }
      if (oneOff.scheme === null && moved.size === 0) return
      setAuditEvents((current) => ({
        ...current,
        [scheme.id]: [
          { id: audit.id, action: audit.action, actor: actorName, at: "Now", reason: audit.reason, before: before.status, after: scheme.status, evidence: audit.evidence(scheme) },
          ...(current[scheme.id] ?? []),
        ],
      }))
      setSelectedRecord((current) => (current?.id === scheme.id ? scheme : current))
      onSaved(scheme)
      const on = formatServiceDate(oneOff.date)
      if (moved.size === routes.size) {
        toast.success(`${scheme.name} — this collection only`, {
          description: `${count(moved.size, "route")} on ${on} moved; later generation runs keep ${moved.size === 1 ? "it" : "them"} as moved. The scheme itself is unchanged.`,
        })
      } else {
        toast.warning(`${scheme.name} — this collection only, in part`, {
          description: `${moved.size} of ${count(routes.size, "route")} on ${on} moved, and later generation runs keep ${moved.size === 1 ? "it" : "them"} as moved; the rest stay as they were. The scheme itself is unchanged.`,
        })
      }
    },
    [actorName, sendCommand, setAuditEvents, setSelectedRecord, upsertRecord],
  )

  const commitSchemeEdit = useCallback(
    (
      before: BusinessRecord,
      after: BusinessRecord,
      audit: SchemeEditAudit,
      onSaved: (scheme: BusinessRecord) => void,
      apply?: SchemeEditApplication,
    ) => {
      if (schemesOnApi) {
        const projectId = typeof before.submittedValues?.projectId === "string" ? before.submittedValues.projectId : undefined
        const today = projectToday(timezoneOfProject(moduleRecords("configure", "organization"), projectId))
        const decided = schemeEditOnApi(before, after, apiRoutes, today, apply)
        if (decided.kind === "ask") {
          setPendingSchemeEdit({ before, after, audit, onSaved, question: decided.question })
          return
        }
        if (decided.kind === "refuse") {
          toast.error(`${after.name} not saved`, { description: decided.message })
          return
        }
        if (decided.kind === "one-off") {
          void moveOneOff(before, decided, audit, onSaved)
          return
        }
        const own = schemeLiveValidation(after, {
          schemes: moduleRecords("route-studio", "schemes"),
          allocations: moduleRecords("fleet", "vehicle-planning"),
          containers: moduleRecords("resources", "containers"),
          vehicles: moduleRecords("fleet", "vehicles"),
        })
        // With the API's containers not placed the zero-match sentence is no evidence, so it keeps no Draft a Draft (#207).
        const validation = own === null ? null : validationWhenUnplaced(own, containersPlaced)
        const scheme: BusinessRecord = { ...after, status: schemeEditStatusOnApi(before.status, validation?.issues ?? null) }
        whenSaved(upsertRecord("route-studio", "schemes", scheme), () => {
          setAuditEvents((current) => ({
            ...current,
            [scheme.id]: [
              { id: audit.id, action: audit.action, actor: actorName, at: "Now", reason: audit.reason, before: before.status, after: scheme.status, evidence: audit.evidence(scheme) },
              ...(current[scheme.id] ?? []),
            ],
          }))
          setSelectedRecord((current) => (current?.id === scheme.id ? scheme : current))
          onSaved(scheme)
          toast.success(`${scheme.name} updated`, decided.following === 0 ? undefined : { description: `The next generation of its routes brings ${count(decided.following, "planned route")} to it.` })
        })
        return
      }
      const schemeEdit = planSchemeEditReconciliation(
        {
          before,
          after,
          today: todayIso(),
          actorName,
          ...(apply ? { apply } : {}),
        },
        {
          schemes: moduleRecords("route-studio", "schemes"),
          existingRoutes: moduleRecords("route-studio", "routes"),
          existingPickups: moduleRecords("route-studio", "pickups"),
          containers: moduleRecords("resources", "containers"),
          vehicles: moduleRecords("fleet", "vehicles"),
          allocations: moduleRecords("fleet", "vehicle-planning"),
          calendarRecords: moduleRecords(
            COLLECTION_CALENDARS_MODULE.workspaceId,
            COLLECTION_CALENDARS_MODULE.moduleId,
          ),
          projectRecords: moduleRecords("configure", "organization"),
        },
      )
      if (schemeEdit.outcome === "ask" && schemeEdit.question) {
        setPendingSchemeEdit({ before, after, audit, onSaved, question: schemeEdit.question })
        return
      }
      if (schemeEdit.outcome === "refused") {
        toast.error(`${after.name} not saved`, { description: schemeEdit.message })
        return
      }
      const scheme = schemeEdit.scheme
      const editEvent: SchemeEditAuditEvent = {
        id: audit.id,
        action: audit.action,
        actor: actorName,
        at: "Now",
        reason: audit.reason,
        before: before.status,
        after: scheme.status,
        evidence: audit.evidence(scheme),
      }
      upsertRecord("route-studio", "schemes", scheme)
      for (const route of schemeEdit.routes) {
        upsertRecord("route-studio", "routes", route)
      }
      for (const pickup of schemeEdit.pickups) {
        upsertRecord("route-studio", "pickups", pickup)
      }
      setAuditEvents((current) => ({
        ...current,
        [scheme.id]: [editEvent, ...(current[scheme.id] ?? [])],
      }))
      setSelectedRecord((current) => (current?.id === scheme.id ? scheme : current))
      onSaved(scheme)
      // The reconciliation consequence line replaces the generic edit toast
      // (issue #33): saving IS the action that reshaped future routes.
      if (schemeEdit.outcome === "draft") {
        toast.warning(`${scheme.name} saved as Draft`, { description: schemeEdit.message })
      } else if (schemeEdit.outcome === "generation-failed") {
        toast.warning(`${scheme.name} updated`, { description: schemeEdit.message })
      } else if (schemeEdit.outcome === "single") {
        toast.success(`${scheme.name} — this collection only`, { description: schemeEdit.message })
      } else {
        toast.success(`${scheme.name} updated`, { description: schemeEdit.message })
      }
    },
    [actorName, apiRoutes, containersPlaced, moduleRecords, moveOneOff, schemesOnApi, setAuditEvents, setSelectedRecord, upsertRecord],
  )

  /** The dialog's answer: the pending edit is planned again, with `apply`, by the commit of this render. */
  const answerPendingSchemeEdit = useCallback(
    (apply: SchemeEditApplication) => {
      if (!pendingSchemeEdit) return
      const { before, after, audit, onSaved } = pendingSchemeEdit
      setPendingSchemeEdit(null)
      commitSchemeEdit(before, after, audit, onSaved, apply)
    },
    [commitSchemeEdit, pendingSchemeEdit],
  )

  /** "Back to the edit": the question is withdrawn, nothing saved; the edit dialog underneath still holds the edit. */
  const dismissPendingSchemeEdit = useCallback(() => setPendingSchemeEdit(null), [])

  return { commitSchemeEdit, pendingSchemeEdit, answerPendingSchemeEdit, dismissPendingSchemeEdit }
}
