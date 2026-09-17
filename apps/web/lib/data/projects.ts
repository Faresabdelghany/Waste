export type Project = {
  id: string
  name: string
  taskCount: number
  progress: number
  startDate: Date
  endDate: Date
  status: "backlog" | "planned" | "active" | "cancelled" | "completed"
  priority: "urgent" | "high" | "medium" | "low"
  tags: string[]
  members: string[]
  client?: string
  typeLabel?: string
  durationLabel?: string
  tasks: Array<{
    id: string
    name: string
    type: "bug" | "improvement" | "task"
    assignee: string
    status: "todo" | "in-progress" | "done"
    startDate: Date
    endDate: Date
  }>
}

// Keep the original demo's stable timeline snapshot so its layout stays identical.
const _today = new Date(2024, 0, 23)
const _base = new Date(_today.getFullYear(), _today.getMonth(), _today.getDate() - 7)
const _d = (offsetDays: number) =>
  new Date(_base.getFullYear(), _base.getMonth(), _base.getDate() + offsetDays)

export const projects: Project[] = [
  {
    id: "1",
    name: "RC-1042 · Central Residual",
    taskCount: 4,
    progress: 82,
    startDate: _d(3),
    endDate: _d(27),
    status: "active",
    priority: "high",
    tags: ["residual", "municipal"],
    members: ["olivia larsen"],
    client: "Copenhagen Central",
    typeLabel: "Daily route",
    durationLabel: "06:10–14:18",
    tasks: [
      {
        id: "1-1",
        name: "Depot departure & vehicle check",
        type: "task",
        assignee: "OL",
        status: "done",
        startDate: _d(3),
        endDate: _d(7),
      },
      {
        id: "1-2",
        name: "Indre By collection sector",
        type: "task",
        assignee: "MJ",
        status: "done",
        startDate: _d(7),
        endDate: _d(13),
      },
      {
        id: "1-3",
        name: "Nordhavn unloading",
        type: "task",
        assignee: "FN",
        status: "in-progress",
        startDate: _d(13),
        endDate: _d(20),
      },
      {
        id: "1-4",
        name: "Proof and route closeout",
        type: "task",
        assignee: "OL",
        status: "todo",
        startDate: _d(20),
        endDate: _d(27),
      },
    ],
  },
  {
    id: "2",
    name: "RC-1048 · Østerbro Organic",
    taskCount: 5,
    progress: 64,
    startDate: _d(3),
    endDate: _d(24),
    status: "active",
    priority: "urgent",
    tags: ["organic", "exception"],
    members: ["olivia larsen"],
    client: "Østerbro Housing",
    typeLabel: "Daily route",
    durationLabel: "06:35–15:05",
    tasks: [
      {
        id: "2-1",
        name: "Pre-trip checklist",
        type: "task",
        assignee: "JH",
        status: "done",
        startDate: _d(3),
        endDate: _d(5),
      },
      {
        id: "2-2",
        name: "Sector A food-waste collection",
        type: "task",
        assignee: "JH",
        status: "done",
        startDate: _d(5),
        endDate: _d(10),
      },
      {
        id: "2-3",
        name: "Blocked-access recollection",
        type: "improvement",
        assignee: "OL",
        status: "in-progress",
        startDate: _d(10),
        endDate: _d(15),
      },
      {
        id: "2-4",
        name: "Weighbridge and disposal",
        type: "task",
        assignee: "JH",
        status: "todo",
        startDate: _d(15),
        endDate: _d(20),
      },
      {
        id: "2-5",
        name: "Exception review",
        type: "task",
        assignee: "OL",
        status: "todo",
        startDate: _d(20),
        endDate: _d(24),
      },
    ],
  },
  {
    id: "3",
    name: "RC-1039 · Vesterbro Paper",
    taskCount: 4,
    progress: 91,
    startDate: _d(1),
    endDate: _d(19),
    status: "active",
    priority: "medium",
    tags: ["paper", "commercial"],
    members: ["olivia larsen"],
    client: "Vesterbro Retail Group",
    typeLabel: "Scheduled route",
    durationLabel: "07:00–12:40",
    tasks: [
      {
        id: "3-1",
        name: "Vehicle and load plan",
        type: "task",
        assignee: "SE",
        status: "done",
        startDate: _d(1),
        endDate: _d(4),
      },
      {
        id: "3-2",
        name: "Retail paper collection",
        type: "task",
        assignee: "SE",
        status: "done",
        startDate: _d(4),
        endDate: _d(10),
      },
      {
        id: "3-3",
        name: "Baled-paper delivery",
        type: "task",
        assignee: "SE",
        status: "done",
        startDate: _d(10),
        endDate: _d(16),
      },
      {
        id: "3-4",
        name: "Close weight discrepancy",
        type: "bug",
        assignee: "OL",
        status: "in-progress",
        startDate: _d(16),
        endDate: _d(19),
      },
    ],
  },
  {
    id: "4",
    name: "RC-1051 · Amager Glass",
    taskCount: 5,
    progress: 48,
    startDate: _d(6),
    endDate: _d(30),
    status: "active",
    priority: "high",
    tags: ["glass", "municipal"],
    members: ["olivia larsen"],
    client: "Amager District",
    typeLabel: "Daily route",
    durationLabel: "06:20–14:50",
    tasks: [
      {
        id: "4-1",
        name: "Container capacity check",
        type: "task",
        assignee: "FN",
        status: "done",
        startDate: _d(6),
        endDate: _d(10),
      },
      {
        id: "4-2",
        name: "Residential glass collection",
        type: "task",
        assignee: "FN",
        status: "in-progress",
        startDate: _d(10),
        endDate: _d(17),
      },
      {
        id: "4-3",
        name: "Overflow response",
        type: "bug",
        assignee: "OL",
        status: "todo",
        startDate: _d(17),
        endDate: _d(21),
      },
      {
        id: "4-4",
        name: "Glass facility delivery",
        type: "task",
        assignee: "FN",
        status: "todo",
        startDate: _d(21),
        endDate: _d(27),
      },
      {
        id: "4-5",
        name: "Route closeout",
        type: "task",
        assignee: "OL",
        status: "todo",
        startDate: _d(27),
        endDate: _d(30),
      },
    ],
  },
  {
    id: "5",
    name: "RC-1044 · Nørrebro Mixed",
    taskCount: 4,
    progress: 100,
    startDate: _d(-8),
    endDate: _d(9),
    status: "completed",
    priority: "low",
    tags: ["mixed", "municipal"],
    members: ["olivia larsen"],
    client: "Nørrebro District",
    typeLabel: "Daily route",
    durationLabel: "Completed",
    tasks: [
      {
        id: "5-1",
        name: "Depot departure",
        type: "task",
        assignee: "MJ",
        status: "done",
        startDate: _d(-8),
        endDate: _d(-4),
      },
      {
        id: "5-2",
        name: "Mixed-waste collections",
        type: "task",
        assignee: "MJ",
        status: "done",
        startDate: _d(-4),
        endDate: _d(2),
      },
      {
        id: "5-3",
        name: "Transfer station delivery",
        type: "task",
        assignee: "MJ",
        status: "done",
        startDate: _d(2),
        endDate: _d(7),
      },
      {
        id: "5-4",
        name: "Closeout approved",
        type: "task",
        assignee: "OL",
        status: "done",
        startDate: _d(7),
        endDate: _d(9),
      },
    ],
  },
  {
    id: "6",
    name: "RS-Central · Week A",
    taskCount: 4,
    progress: 20,
    startDate: _d(14),
    endDate: _d(37),
    status: "planned",
    priority: "medium",
    tags: ["route-scheme", "municipal"],
    members: ["olivia larsen"],
    client: "Copenhagen Central",
    typeLabel: "Route scheme",
    durationLabel: "Week A",
    tasks: [
      {
        id: "6-1",
        name: "Validate service frequencies",
        type: "task",
        assignee: "OL",
        status: "in-progress",
        startDate: _d(14),
        endDate: _d(19),
      },
      {
        id: "6-2",
        name: "Assign vehicles and drivers",
        type: "task",
        assignee: "OL",
        status: "todo",
        startDate: _d(19),
        endDate: _d(25),
      },
      {
        id: "6-3",
        name: "Review capacity constraints",
        type: "task",
        assignee: "OL",
        status: "todo",
        startDate: _d(25),
        endDate: _d(31),
      },
      {
        id: "6-4",
        name: "Publish operating plan",
        type: "task",
        assignee: "OL",
        status: "todo",
        startDate: _d(31),
        endDate: _d(37),
      },
    ],
  },
  {
    id: "7",
    name: "Recollection Batch · Central",
    taskCount: 3,
    progress: 33,
    startDate: _d(10),
    endDate: _d(22),
    status: "active",
    priority: "urgent",
    tags: ["exception", "recollection"],
    members: ["olivia larsen"],
    client: "Copenhagen Central",
    typeLabel: "Recovery route",
    durationLabel: "8 open stops",
    tasks: [
      {
        id: "7-1",
        name: "Confirm failed-stop evidence",
        type: "bug",
        assignee: "OL",
        status: "done",
        startDate: _d(10),
        endDate: _d(13),
      },
      {
        id: "7-2",
        name: "Dispatch recollection vehicle",
        type: "task",
        assignee: "JH",
        status: "in-progress",
        startDate: _d(13),
        endDate: _d(18),
      },
      {
        id: "7-3",
        name: "Verify recovery proof",
        type: "task",
        assignee: "OL",
        status: "todo",
        startDate: _d(18),
        endDate: _d(22),
      },
    ],
  },
  {
    id: "8",
    name: "Harbor Commercial Cardboard",
    taskCount: 4,
    progress: 0,
    startDate: _d(25),
    endDate: _d(45),
    status: "backlog",
    priority: "medium",
    tags: ["paper", "commercial"],
    members: [],
    client: "Harbor Offices ApS",
    typeLabel: "Contract route",
    durationLabel: "Pending capacity",
    tasks: [
      {
        id: "8-1",
        name: "Confirm agreement coverage",
        type: "task",
        assignee: "—",
        status: "todo",
        startDate: _d(25),
        endDate: _d(29),
      },
      {
        id: "8-2",
        name: "Register service points",
        type: "task",
        assignee: "—",
        status: "todo",
        startDate: _d(29),
        endDate: _d(34),
      },
      {
        id: "8-3",
        name: "Allocate containers",
        type: "task",
        assignee: "—",
        status: "todo",
        startDate: _d(34),
        endDate: _d(39),
      },
      {
        id: "8-4",
        name: "Schedule first collection",
        type: "task",
        assignee: "—",
        status: "todo",
        startDate: _d(39),
        endDate: _d(45),
      },
    ],
  },
  {
    id: "9",
    name: "RC-1055 · Frederiksberg Textile",
    taskCount: 3,
    progress: 12,
    startDate: _d(18),
    endDate: _d(34),
    status: "planned",
    priority: "low",
    tags: ["textile", "municipal"],
    members: ["olivia larsen"],
    client: "Frederiksberg Municipality",
    typeLabel: "Pilot route",
    durationLabel: "09:00–13:00",
    tasks: [
      {
        id: "9-1",
        name: "Confirm pilot service points",
        type: "task",
        assignee: "OL",
        status: "in-progress",
        startDate: _d(18),
        endDate: _d(23),
      },
      {
        id: "9-2",
        name: "Place textile containers",
        type: "task",
        assignee: "SE",
        status: "todo",
        startDate: _d(23),
        endDate: _d(29),
      },
      {
        id: "9-3",
        name: "Launch pilot collections",
        type: "task",
        assignee: "SE",
        status: "todo",
        startDate: _d(29),
        endDate: _d(34),
      },
    ],
  },
  {
    id: "10",
    name: "Bin Deployment · Islands Brygge",
    taskCount: 3,
    progress: 100,
    startDate: _d(-12),
    endDate: _d(-1),
    status: "completed",
    priority: "medium",
    tags: ["assets", "deployment"],
    members: ["olivia larsen"],
    client: "Islands Brygge Housing",
    typeLabel: "Asset deployment",
    durationLabel: "42 containers",
    tasks: [
      {
        id: "10-1",
        name: "Receive and label containers",
        type: "task",
        assignee: "FN",
        status: "done",
        startDate: _d(-12),
        endDate: _d(-8),
      },
      {
        id: "10-2",
        name: "Install containers on site",
        type: "task",
        assignee: "FN",
        status: "done",
        startDate: _d(-8),
        endDate: _d(-3),
      },
      {
        id: "10-3",
        name: "Customer acceptance",
        type: "task",
        assignee: "OL",
        status: "done",
        startDate: _d(-3),
        endDate: _d(-1),
      },
    ],
  },
]

export type FilterCounts = {
  status?: Record<string, number>
  priority?: Record<string, number>
  tags?: Record<string, number>
  members?: Record<string, number>
}

export function computeFilterCounts(list: Project[]): FilterCounts {
  const res: FilterCounts = {
    status: {},
    priority: {},
    tags: {},
    members: {},
  }

  for (const project of list) {
    res.status![project.status] = (res.status![project.status] || 0) + 1
    res.priority![project.priority] = (res.priority![project.priority] || 0) + 1

    for (const tag of project.tags) {
      const id = tag.toLowerCase()
      res.tags![id] = (res.tags![id] || 0) + 1
    }

    if (project.members.length === 0) {
      res.members!["no-member"] = (res.members!["no-member"] || 0) + 1
    } else {
      res.members!["current"] = (res.members!["current"] || 0) + 1
    }

    if (project.members.some((member) => member.toLowerCase() === "olivia larsen")) {
      res.members!["olivia"] = (res.members!["olivia"] || 0) + 1
    }
  }

  return res
}
