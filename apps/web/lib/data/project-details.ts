import type { Project as ProjectListItem } from "@/lib/data/projects"
import { projects } from "@/lib/data/projects"
import { getAvatarUrl } from "@/lib/assets/avatars"

function addDays(base: Date, days: number): Date {
  const date = new Date(base)
  date.setDate(date.getDate() + days)
  return date
}

export type User = {
  id: string
  name: string
  avatarUrl?: string
  role?: string
}

export type ProjectMeta = {
  priorityLabel: string
  locationLabel: string
  sprintLabel: string
  lastSyncLabel: string
}

export type ProjectScope = {
  inScope: string[]
  outOfScope: string[]
}

export type KeyFeatures = {
  p0: string[]
  p1: string[]
  p2: string[]
}

export type TimelineTask = {
  id: string
  name: string
  startDate: Date
  endDate: Date
  status: "planned" | "in-progress" | "done"
}

export type WorkstreamTaskStatus = "todo" | "in-progress" | "done"

export type WorkstreamTask = {
  id: string
  name: string
  status: WorkstreamTaskStatus
  dueLabel?: string
  dueTone?: "danger" | "warning" | "muted"
  assignee?: User
  startDate?: Date
  priority?: "no-priority" | "low" | "medium" | "high" | "urgent"
  tag?: string
  description?: string
}

export type WorkstreamGroup = {
  id: string
  name: string
  tasks: WorkstreamTask[]
}

export type ProjectTask = WorkstreamTask & {
  projectId: string
  projectName: string
  workstreamId: string
  workstreamName: string
}

export type TimeSummary = {
  estimateLabel: string
  dueDate: Date
  daysRemainingLabel: string
  progressPercent: number
}

export type BacklogSummary = {
  statusLabel: "Active" | "Backlog" | "Planned" | "Completed" | "Cancelled"
  groupLabel: string
  priorityLabel: string
  labelBadge: string
  picUsers: User[]
  supportUsers?: User[]
}

export type QuickLink = {
  id: string
  name: string
  type: "pdf" | "zip" | "fig" | "doc" | "file"
  sizeMB: number
  url: string
}

export type ProjectFile = QuickLink & {
  addedBy: User
  addedDate: Date
  description?: string
  isLinkAsset?: boolean
  attachments?: QuickLink[]
}

export type NoteType = "general" | "meeting" | "audio"
export type NoteStatus = "completed" | "processing"

export type TranscriptSegment = {
  id: string
  speaker: string
  timestamp: string
  text: string
}

export type AudioNoteData = {
  duration: string
  fileName: string
  aiSummary: string
  keyPoints: string[]
  insights: string[]
  transcript: TranscriptSegment[]
}

export type ProjectNote = {
  id: string
  title: string
  content?: string
  noteType: NoteType
  status: NoteStatus
  addedDate: Date
  addedBy: User
  audioData?: AudioNoteData
}

export type ProjectDetails = {
  id: string
  name: string
  description: string
  meta: ProjectMeta
  scope: ProjectScope
  outcomes: string[]
  keyFeatures: KeyFeatures
  timelineTasks: TimelineTask[]
  workstreams: WorkstreamGroup[]
  time: TimeSummary
  backlog: BacklogSummary
  quickLinks: QuickLink[]
  files: ProjectFile[]
  notes: ProjectNote[]
  source?: ProjectListItem
}

export function getProjectTasks(details: ProjectDetails): ProjectTask[] {
  return details.workstreams.flatMap((group) =>
    group.tasks.map((task) => ({
      ...task,
      projectId: details.id,
      projectName: details.name,
      workstreamId: group.id,
      workstreamName: group.name,
    })),
  )
}

function userFromName(name: string, role?: string): User {
  return {
    id: name.trim().toLowerCase().replace(/\s+/g, "-"),
    name,
    avatarUrl: getAvatarUrl(name),
    role,
  }
}

function getStatusLabel(status: ProjectListItem["status"]): BacklogSummary["statusLabel"] {
  if (status === "active") return "Active"
  if (status === "backlog") return "Backlog"
  if (status === "planned") return "Planned"
  if (status === "completed") return "Completed"
  return "Cancelled"
}

function buildProjectDetails(project: ProjectListItem): ProjectDetails {
  const picUsers = project.members.map((name) => userFromName(name, "Operations"))
  const primaryAssignee = picUsers[0]
  const dispatchUser = userFromName("Dispatch Team", "Support")

  const routeTasks: WorkstreamTask[] = project.tasks.map((task) => ({
    id: task.id,
    name: task.name,
    status: task.status,
    dueLabel:
      task.status === "done"
        ? "Completed"
        : task.status === "in-progress"
          ? "In progress"
          : "Scheduled",
    dueTone: task.status === "in-progress" ? "warning" : "muted",
    assignee: primaryAssignee,
    startDate: task.startDate,
    priority: project.priority,
    tag:
      task.type === "bug"
        ? "Exception"
        : task.type === "improvement"
          ? "Recovery"
          : "Service stop",
    description:
      task.type === "bug"
        ? "Operational exception requiring review, evidence, and a resolution decision."
        : "Planned route activity with execution status and service proof.",
  }))

  return {
    id: project.id,
    name: project.name,
    description: project.client
      ? `${project.typeLabel ?? "Collection route"} for ${project.client}, covering scheduled service stops, assigned resources, disposal, proof, and exception handling.`
      : "Operational route covering scheduled service stops, assigned resources, disposal, proof, and exception handling.",
    meta: {
      priorityLabel:
        project.priority.charAt(0).toUpperCase() + project.priority.slice(1),
      locationLabel: "Copenhagen",
      sprintLabel: [project.typeLabel, project.durationLabel]
        .filter(Boolean)
        .join(" · "),
      lastSyncLabel: "Just now",
    },
    scope: {
      inScope: [
        "Scheduled customer service points",
        "Assigned vehicle and driver",
        "Collection proof and exception evidence",
        "Disposal or unloading confirmation",
      ],
      outOfScope: [
        "Unapproved service changes",
        "Waste fractions outside the customer agreement",
      ],
    },
    outcomes: [
      "Complete every eligible stop within its service window",
      "Capture proof for completed and failed stops",
      "Resolve operational exceptions with a clear audit trail",
      "Close the route with verified disposal data",
    ],
    keyFeatures: {
      p0: ["Stop execution", "Driver and vehicle assignment"],
      p1: ["Exception handling", "Proof verification"],
      p2: ["Cost, weight, and billing reconciliation"],
    },
    timelineTasks: project.tasks.map((task) => ({
      id: `${task.id}-timeline`,
      name: task.name,
      startDate: task.startDate,
      endDate: task.endDate,
      status: task.status === "todo" ? "planned" : task.status,
    })),
    workstreams: [
      {
        id: `${project.id}-route-execution`,
        name: "Route execution",
        tasks: routeTasks,
      },
    ],
    time: {
      estimateLabel: project.durationLabel ?? "Scheduled route",
      dueDate: project.endDate,
      daysRemainingLabel:
        project.status === "completed" ? "Route closed" : "Live operating window",
      progressPercent: project.progress,
    },
    backlog: {
      statusLabel: getStatusLabel(project.status),
      groupLabel: project.client ?? "Unassigned customer",
      priorityLabel:
        project.priority.charAt(0).toUpperCase() + project.priority.slice(1),
      labelBadge: project.tags[0] ?? "Operations",
      picUsers,
      supportUsers: [dispatchUser],
    },
    quickLinks: [
      {
        id: `${project.id}-manifest`,
        name: "Route manifest.pdf",
        type: "pdf",
        sizeMB: 1.2,
        url: "#",
      },
      {
        id: `${project.id}-agreement`,
        name: "Service agreement.pdf",
        type: "pdf",
        sizeMB: 2.4,
        url: "#",
      },
    ],
    files: [],
    notes: [
      {
        id: `${project.id}-note-1`,
        title: "Dispatch briefing",
        noteType: "meeting",
        status: "completed",
        addedDate: new Date(),
        addedBy: primaryAssignee ?? dispatchUser,
        content:
          "Driver, vehicle, service windows, disposal destination, and known access constraints were reviewed before dispatch.",
      },
      {
        id: `${project.id}-note-2`,
        title: "Exception review",
        noteType: "general",
        status: "completed",
        addedDate: addDays(new Date(), -1),
        addedBy: primaryAssignee ?? dispatchUser,
        content:
          "Failed stops require a reason code and evidence before a recollection or customer response can be approved.",
      },
      {
        id: `${project.id}-note-3`,
        title: "Route closeout",
        noteType: "general",
        status: project.status === "completed" ? "completed" : "processing",
        addedDate: addDays(new Date(), -1),
        addedBy: primaryAssignee ?? dispatchUser,
        content:
          "Closeout verifies stop outcomes, proof completeness, disposal weight, and billable service events.",
      },
    ],
    source: project,
  }
}

export function getProjectDetailsById(id: string): ProjectDetails {
  const project =
    projects.find((item) => item.id === id) ??
    ({
      id,
      name: `Untitled route ${id}`,
      taskCount: 0,
      progress: 0,
      startDate: new Date(),
      endDate: new Date(),
      status: "planned",
      priority: "medium",
      tags: [],
      members: [],
      tasks: [],
    } satisfies ProjectListItem)

  return buildProjectDetails(project)
}
