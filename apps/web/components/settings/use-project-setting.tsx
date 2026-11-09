"use client"

// The scaffold of a pane that configures one project at a time against the
// API: the project shown (`projectShown`: the one picked, else the first by
// name), the project's setting as read, a draft and its refusal held for that
// project, and a save that tells what it saved — or the API's refusal — and
// reads the setting again.

import { useState } from "react"
import { toast } from "sonner"

import type { Me } from "@waste/contracts/me"
import { useReport } from "@/components/platform/use-report"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApiClient, useApiSession } from "@/components/platform/api-session-store"
import type { ApiClient } from "@/lib/api/client"
import { problemOfError, problemSentence, type Problem } from "@/lib/api/problem"
import { projectShown } from "@/lib/data/project-scope"

type MeProject = Me["projects"][number]

/** A project picked for several panes at once: the tabs of Settings › Tickets share theirs. */
export type ProjectPick = { projectId: string | null; onProjectChange: (projectId: string) => void }

export type ProjectSettingResource<Read> = {
  /** What the read is kept under, beside the project. */
  name: string
  /** Whether the role reads it; false asks nothing. */
  readable: boolean
  read: (client: ApiClient, projectId: string) => Promise<Read>
}

/** How a save is told: what it saved, once the API has answered, or the title of its refusal, beneath which the API's sentence stands. */
export type SaveTold<Written> = { saved: (written: Written) => { title: string; description: string }; failed: string }

export type ProjectSetting<Read, Draft, Refusal> = {
  projects: readonly MeProject[]
  project: MeProject | null
  pickProject: (projectId: string) => void
  /** The project's setting as the API last answered it, by a read or a save; null while it is on its way or when it was refused. */
  base: Read | null
  /** What a list shows: `base`, else the last read, another project's or before a save, while the next is on its way. */
  shown: Read | null
  problem: Problem | null
  draft: Draft | null
  refusal: Refusal | null
  edit: (draft: Draft) => void
  refuse: (refusal: Refusal) => void
  discard: () => void
  saving: boolean
  /** Writes through the client; once the API takes it, the draft is dropped and the setting read again, `answers` standing for it meanwhile. */
  save: <Written>(write: (client: ApiClient, projectId: string) => Promise<Written>, told: SaveTold<Written>, answers?: (written: Written) => Read) => void
}

export function useProjectSetting<Read, Draft = never, Refusal = never>(resource: ProjectSettingResource<Read>, shared?: ProjectPick): ProjectSetting<Read, Draft, Refusal> {
  const client = useApiClient()
  const { me } = useApiSession()
  const projects = me?.projects ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const pick = shared ?? { projectId: picked, onProjectChange: setPicked }
  const project = projectShown(projects, pick.projectId, (candidate) => candidate.id)
  const scope = project === null ? null : `${resource.name}:${project.id}`
  const [version, setVersion] = useState(0)
  const key = scope === null || !resource.readable ? null : `${scope}:${version}`
  const read = useReport<Read>(key, (asking) => resource.read(asking, project?.id ?? ""))
  const [answered, setAnswered] = useState<{ key: string; value: Read } | null>(null)
  const base = read.report ?? (answered !== null && answered.key === key ? answered.value : null)
  const [held, setHeld] = useState<{ scope: string; draft: Draft | null; refusal: Refusal | null } | null>(null)
  const current = held !== null && held.scope === scope ? held : null
  const [saving, setSaving] = useState(false)

  const save = <Written,>(write: (client: ApiClient, projectId: string) => Promise<Written>, told: SaveTold<Written>, answers?: (written: Written) => Read) => {
    if (client === null || scope === null || project === null) return
    setSaving(true)
    write(client, project.id)
      .then(
        (written) => {
          setHeld(null)
          if (answers !== undefined) setAnswered({ key: `${scope}:${version + 1}`, value: answers(written) })
          setVersion(version + 1)
          const { title, description } = told.saved(written)
          toast.success(title, { description })
        },
        (error: unknown) => toast.error(told.failed, { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setSaving(false))
  }

  return {
    projects,
    project,
    pickProject: pick.onProjectChange,
    base,
    shown: base ?? read.shown,
    problem: read.problem,
    draft: current?.draft ?? null,
    refusal: current?.refusal ?? null,
    edit: (draft) => scope !== null && setHeld({ scope, draft, refusal: null }),
    refuse: (refusal) => scope !== null && setHeld({ scope, draft: current?.draft ?? null, refusal }),
    discard: () => setHeld(null),
    saving,
    save,
  }
}

/** The project a per-project pane shows, picked; held while `disabled`, as while a draft would be dropped unasked. */
export function ProjectPicker({ id, setting, disabled = false }: { id: string; setting: Pick<ProjectSetting<unknown, unknown, unknown>, "projects" | "project" | "pickProject">; disabled?: boolean }) {
  const { projects, project, pickProject } = setting
  return (
    <>
      <Label htmlFor={id} className="text-sm text-muted-foreground">
        Project
      </Label>
      <Select value={project?.id ?? ""} onValueChange={pickProject} disabled={projects.length === 0 || disabled}>
        <SelectTrigger id={id} className="w-64">
          <SelectValue placeholder="Pick a project" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              {candidate.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  )
}
