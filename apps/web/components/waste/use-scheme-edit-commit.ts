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
// generates its routes, so most of that does not run: the edit is the scheme's,
// under the status the wire has — the web's validation never lowers a
// validated scheme, the API's 409 speaking for one the edit breaks, and a
// Draft the edit leaves without a blocking issue asks to be validated, the
// browser path's rule (`schemeEditStatusOnApi`) — and the next generation
// run reconciles its routes. The dialog closes once the API has taken the
// edit. The question returns there with the routes on the API (#179): the
// same rule over the routes the API holds (`schemeEditOnApi`). "Apply to
// future collections" saves the scheme, and its planned routes follow it when
// its routes are next generated. "This collection only" (#209) moves the next
// collection's routes by their own commands, which the API holds against
// later runs, the scheme keeping its configuration (`schemeOneOffOnApi`); an
// edit those commands cannot carry shows it disabled with the reason, and a
// stored one-off refuses it. Until the routes module has read the API's
// routes, an edit that would ask is refused, since how it applies cannot be
// asked.

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react"
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
  // The route commands come from the store as the routes' state does: the workspace that supplies the deps is fenced (#209).
  const { sendCommand } = useBusinessRecordStore()
  // One one-off at a time: a second save while one runs would send its commands again.
  const oneOffRunning = useRef(false)

  /**
   * "This collection only" on the Pilot (#209): the scheme's rename or policy
   * first, through `whenSaved`, then each route's commands in turn, the API
   * holding every route it moves against later generation runs. A refusal
   * stops the run, the store having told it in the API's words; what moved
   * before it stays moved and is said, a route counted moved once all its
   * commands are in. With nothing moved the edit dialog stays open on it.
   */
  const moveOneOff = useCallback(
    (before: BusinessRecord, oneOff: SchemeOneOff, audit: SchemeEditAudit, onSaved: (scheme: BusinessRecord) => void) => {
      if (oneOffRunning.current) return
      const scheme = oneOff.scheme ?? before
      const commandsOf = new Map<string, number>()
      for (const move of oneOff.moves) commandsOf.set(move.routeId, (commandsOf.get(move.routeId) ?? 0) + 1)
      const run = async () => {
        const done = new Map<string, number>()
        for (const move of oneOff.moves) {
          if ((await sendCommand("route-studio", "routes", move.routeId, move.command, move.input)).kind === "refused") break
          done.set(move.routeId, (done.get(move.routeId) ?? 0) + 1)
        }
        const on = formatServiceDate(oneOff.date)
        if (done.size === 0) {
          if (oneOff.scheme !== null) toast.warning(`${scheme.name} saved; its next collection is not moved`, { description: `Its name and policy are saved. No route on ${on} was moved.` })
          return
        }
        setAuditEvents((current) => ({
          ...current,
          [scheme.id]: [
            { id: audit.id, action: audit.action, actor: actorName, at: "Now", reason: audit.reason, before: before.status, after: scheme.status, evidence: audit.evidence(scheme) },
            ...(current[scheme.id] ?? []),
          ],
        }))
        setSelectedRecord((current) => (current?.id === scheme.id ? scheme : current))
        onSaved(scheme)
        const moved = [...commandsOf].filter(([routeId, commands]) => done.get(routeId) === commands).length
        const them = (n: number) => (n === 1 ? "it" : "them")
        if (moved === commandsOf.size) {
          toast.success(`${scheme.name} — this collection only`, {
            description: `${count(moved, "route")} on ${on} moved; later generation runs keep ${them(moved)} as moved. The scheme keeps its configuration.`,
          })
        } else {
          toast.warning(`${scheme.name} — this collection only, in part`, {
            description: `${count(done.size, "route")} of ${commandsOf.size} on ${on} moved${moved < done.size ? `, ${done.size - moved} of them in part` : ""}; later generation runs keep ${them(done.size)} as moved, and the rest stay as they were. The scheme keeps its configuration.`,
          })
        }
      }
      const start = () => {
        oneOffRunning.current = true
        void run().finally(() => {
          oneOffRunning.current = false
        })
      }
      if (oneOff.scheme === null) start()
      else whenSaved(upsertRecord("route-studio", "schemes", oneOff.scheme), start)
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
          moveOneOff(before, decided, audit, onSaved)
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
