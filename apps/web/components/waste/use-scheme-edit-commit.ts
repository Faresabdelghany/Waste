"use client"

// The one edit-save of a route scheme (issue #33, D31; the edit policy of
// issue #38), as a hook the workspace calls from both edit doors — the schema
// dialog and the collection groups editor. The API holds the scheme and
// generates its routes, so the edit is the scheme's, under the status the
// wire has — the web's validation never lowers a validated scheme, the API's
// 409 speaking for one the edit breaks, and a Draft the edit leaves without a
// blocking issue asks to be validated (`schemeEditStatusOnApi`) — and the
// next generation run reconciles its routes. The dialog closes once the API
// has taken the edit.
//
// Under "Ask each time" the edit may answer with a question instead (the
// rule over the routes the API holds, `schemeEditOnApi`, #179). The hook then
// keeps only the edit itself — `{ before, after, onSaved }` and the question —
// as `pendingSchemeEdit`; the edit dialog stays open underneath so "Back to
// the edit" loses nothing, and the answer goes through
// `answerPendingSchemeEdit`, which calls the CURRENT commit. "Apply to future
// collections" saves the scheme, and its planned routes follow it when its
// routes are next generated. "This collection only" (#209) moves the next
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
import { dayIn } from "@/lib/api/records/clock"
import { schemeEditOnApi, schemeEditStatusOnApi, timezoneOfProject, validationWhenUnplaced, type SchemeOneOff } from "@/lib/data/route-schemes"
import type { SchemeEditApplication, SchemeEditQuestion } from "@/lib/prototype/route-schemes/edit"
import { schemeLiveValidation } from "@/lib/prototype/route-schemes/lifecycle"
import { formatShortDay } from "@waste/domain/days"
import { count } from "@waste/domain/text"

/**
 * A scheme edit answered with a question (issue #38): the edit as it was
 * submitted, kept until the person answers or goes back, and the question to
 * show. Deliberately no callback that decides — the answer decides again
 * through the current `commitSchemeEdit`.
 */
export type PendingSchemeEdit = {
  before: BusinessRecord
  after: BusinessRecord
  onSaved: (scheme: BusinessRecord) => void
  question: SchemeEditQuestion
}

export type SchemeEditCommitDeps = {
  /** The live records of any workspace module, read when the edit is decided. */
  moduleRecords: (workspaceId: WorkspaceId, moduleId: string) => BusinessRecord[]
  upsertRecord: (workspaceId: WorkspaceId, moduleId: string, record: BusinessRecord) => Promise<WriteOutcome> | undefined
  /** The workspace's selected record: refreshed when it is the scheme just saved. */
  setSelectedRecord: Dispatch<SetStateAction<BusinessRecord | null>>
}

export function useSchemeEditCommit({
  moduleRecords,
  upsertRecord,
  setSelectedRecord,
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
    (before: BusinessRecord, oneOff: SchemeOneOff, onSaved: (scheme: BusinessRecord) => void) => {
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
        const on = formatShortDay(oneOff.date)
        if (done.size === 0) {
          if (oneOff.scheme !== null) toast.warning(`${scheme.name} saved; its next collection is not moved`, { description: `Its name and policy are saved. No route on ${on} was moved.` })
          return
        }
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
    [sendCommand, setSelectedRecord, upsertRecord],
  )

  const commitSchemeEdit = useCallback(
    (
      before: BusinessRecord,
      after: BusinessRecord,
      onSaved: (scheme: BusinessRecord) => void,
      apply?: SchemeEditApplication,
    ) => {
      const projectId = typeof before.submittedValues?.projectId === "string" ? before.submittedValues.projectId : undefined
      const today = dayIn(new Date(), timezoneOfProject(moduleRecords("configure", "organization"), projectId))
      const decided = schemeEditOnApi(before, after, apiRoutes, today, apply)
      if (decided.kind === "ask") {
        setPendingSchemeEdit({ before, after, onSaved, question: decided.question })
        return
      }
      if (decided.kind === "refuse") {
        toast.error(`${after.name} not saved`, { description: decided.message })
        return
      }
      if (decided.kind === "one-off") {
        moveOneOff(before, decided, onSaved)
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
        setSelectedRecord((current) => (current?.id === scheme.id ? scheme : current))
        onSaved(scheme)
        toast.success(`${scheme.name} updated`, decided.following === 0 ? undefined : { description: `The next generation of its routes brings ${count(decided.following, "planned route")} to it.` })
      })
    },
    [apiRoutes, containersPlaced, moduleRecords, moveOneOff, setSelectedRecord, upsertRecord],
  )

  /** The dialog's answer: the pending edit is decided again, with `apply`, by the commit of this render. */
  const answerPendingSchemeEdit = useCallback(
    (apply: SchemeEditApplication) => {
      if (!pendingSchemeEdit) return
      const { before, after, onSaved } = pendingSchemeEdit
      setPendingSchemeEdit(null)
      commitSchemeEdit(before, after, onSaved, apply)
    },
    [commitSchemeEdit, pendingSchemeEdit],
  )

  /** "Back to the edit": the question is withdrawn, nothing saved; the edit dialog underneath still holds the edit. */
  const dismissPendingSchemeEdit = useCallback(() => setPendingSchemeEdit(null), [])

  return { commitSchemeEdit, pendingSchemeEdit, answerPendingSchemeEdit, dismissPendingSchemeEdit }
}
