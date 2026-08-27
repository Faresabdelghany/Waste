export type RouteHealthStatus = "At risk" | "Monitor" | "On track"

export type RoutePerformanceRow = {
  id: string
  name: string
  area: string
  serviceType: string
  stopsCompleted: number
  stopsPlanned: number
  onTimePercent: number
  proofComplete: number
  exceptions: number
  openTickets: number
  ticketSlaPercent: number
  slaPercent: number
  status: RouteHealthStatus
  issue: string
  issueDetail: string
  trend: number[]
}

export type TicketImpact = "High" | "Medium" | "Low"

export type TicketAttentionRow = {
  /** Display code, e.g. "T-8831". */
  id: string
  /** Business record id the tickets page opens, e.g. "ticket-8831". */
  recordId: string
  subject: string
  issue: string
  issueDetail: string
  impact: TicketImpact
}

export type ThroughputPoint = {
  date: Date
  completed: number
  previous: number
}

export type PerformancePortfolioSummary = {
  onTimePercent: number
  onTimeRoutes: number
  totalRoutes: number
  completed: number
  planned: number
  openTickets: number
  ticketRouteCount: number
  resolvedWithinSla: number
  resolvedTotal: number
}

export const PERFORMANCE_REFERENCE_DATE = new Date(2026, 7, 12)

export const ROUTE_PERFORMANCE_ROWS: RoutePerformanceRow[] = [
  {
    id: "RC-1042",
    name: "Central Residual",
    area: "Central",
    serviceType: "Residual",
    stopsCompleted: 186,
    stopsPlanned: 232,
    onTimePercent: 62,
    proofComplete: 145,
    exceptions: 5,
    openTickets: 4,
    ticketSlaPercent: 71,
    slaPercent: 62,
    status: "At risk",
    issue: "SLA misses",
    issueDetail: "5 in last 7 days",
    trend: [76, 74, 72, 72, 68, 66, 64, 62],
  },
  {
    id: "RC-1048",
    name: "Østerbro Organic",
    area: "Østerbro",
    serviceType: "Organic",
    stopsCompleted: 512,
    stopsPlanned: 624,
    onTimePercent: 79,
    proofComplete: 466,
    exceptions: 4,
    openTickets: 1,
    ticketSlaPercent: 78,
    slaPercent: 79,
    status: "Monitor",
    issue: "Open exceptions",
    issueDetail: "4 exceptions",
    trend: [76, 78, 77, 80, 79, 81, 78, 79],
  },
  {
    id: "RC-1017",
    name: "Frederiksberg Mixed",
    area: "Frederiksberg",
    serviceType: "Mixed",
    stopsCompleted: 468,
    stopsPlanned: 492,
    onTimePercent: 93,
    proofComplete: 440,
    exceptions: 1,
    openTickets: 0,
    ticketSlaPercent: 97,
    slaPercent: 93,
    status: "On track",
    issue: "Stable service",
    issueDetail: "No action needed",
    trend: [86, 88, 87, 89, 90, 91, 92, 93],
  },
  {
    id: "RC-1051",
    name: "Amager Glass",
    area: "Amager",
    serviceType: "Glass",
    stopsCompleted: 198,
    stopsPlanned: 256,
    onTimePercent: 58,
    proofComplete: 144,
    exceptions: 9,
    openTickets: 5,
    ticketSlaPercent: 64,
    slaPercent: 58,
    status: "At risk",
    issue: "Proof incomplete",
    issueDetail: "68 stops",
    trend: [73, 70, 68, 66, 64, 61, 60, 58],
  },
  {
    id: "RC-1009",
    name: "Vesterbro Mixed",
    area: "Vesterbro",
    serviceType: "Mixed",
    stopsCompleted: 430,
    stopsPlanned: 488,
    onTimePercent: 88,
    proofComplete: 413,
    exceptions: 0,
    openTickets: 0,
    ticketSlaPercent: 98,
    slaPercent: 88,
    status: "On track",
    issue: "Stable service",
    issueDetail: "No action needed",
    trend: [82, 84, 83, 85, 86, 85, 87, 88],
  },
  {
    id: "RC-1022",
    name: "Nørrebro Mixed",
    area: "Nørrebro",
    serviceType: "Mixed",
    stopsCompleted: 544,
    stopsPlanned: 596,
    onTimePercent: 84,
    proofComplete: 484,
    exceptions: 2,
    openTickets: 2,
    ticketSlaPercent: 86,
    slaPercent: 84,
    status: "Monitor",
    issue: "Route over time",
    issueDetail: "+18% vs plan",
    trend: [88, 87, 87, 86, 84, 85, 84, 84],
  },
  {
    id: "RC-1033",
    name: "Vesterbro Paper",
    area: "Vesterbro",
    serviceType: "Paper",
    stopsCompleted: 446,
    stopsPlanned: 492,
    onTimePercent: 81,
    proofComplete: 428,
    exceptions: 3,
    openTickets: 2,
    ticketSlaPercent: 84,
    slaPercent: 81,
    status: "Monitor",
    issue: "Stops behind",
    issueDetail: "12 stops",
    trend: [86, 85, 83, 82, 84, 82, 81, 81],
  },
  {
    id: "RC-1039",
    name: "Vesterbro Paper",
    area: "Vesterbro",
    serviceType: "Paper",
    stopsCompleted: 676,
    stopsPlanned: 711,
    onTimePercent: 96,
    proofComplete: 663,
    exceptions: 0,
    openTickets: 0,
    ticketSlaPercent: 99,
    slaPercent: 96,
    status: "On track",
    issue: "Stable service",
    issueDetail: "No action needed",
    trend: [91, 92, 92, 93, 94, 94, 95, 96],
  },
  {
    id: "RC-1044",
    name: "Nørrebro Residual",
    area: "Nørrebro",
    serviceType: "Residual",
    stopsCompleted: 548,
    stopsPlanned: 576,
    onTimePercent: 91,
    proofComplete: 532,
    exceptions: 1,
    openTickets: 1,
    ticketSlaPercent: 95,
    slaPercent: 91,
    status: "On track",
    issue: "Stable service",
    issueDetail: "No action needed",
    trend: [87, 88, 89, 88, 89, 90, 90, 91],
  },
  {
    id: "RC-1055",
    name: "Frederiksberg Textile",
    area: "Frederiksberg",
    serviceType: "Textile",
    stopsCompleted: 538,
    stopsPlanned: 621,
    onTimePercent: 76,
    proofComplete: 463,
    exceptions: 2,
    openTickets: 1,
    ticketSlaPercent: 88,
    slaPercent: 76,
    status: "Monitor",
    issue: "Stops behind",
    issueDetail: "12 stops",
    trend: [82, 81, 80, 78, 79, 77, 76, 76],
  },
]

const CURRENT_PERIOD_VALUES = [
  128, 154, 172, 149, 188, 205, 167, 143, 132, 156,
  176, 201, 184, 165, 147, 139, 158, 193, 219, 205,
  237, 254, 221, 232, 243, 214, 193, 204, 221, 191,
]

export const THROUGHPUT_SERIES: ThroughputPoint[] = CURRENT_PERIOD_VALUES.map(
  (completed, index) => {
    const date = new Date(2026, 6, 14 + index)
    const previous = Math.max(
      96,
      Math.round(completed * (0.9 + ((index * 7) % 13) / 100)),
    )

    return {
      date,
      completed,
      previous,
    }
  },
)

// Top open tickets by operational impact; recordIds match the Tickets module
// fixtures in business-modules.ts so each row opens a real ticket record.
export const TICKET_ATTENTION_ROWS: TicketAttentionRow[] = [
  {
    id: "T-8826",
    recordId: "ticket-8826",
    subject: "Glass container overflow",
    issue: "Overflow",
    issueDetail: "Critical · SLA due in 1 h 26 min",
    impact: "High",
  },
  {
    id: "T-8840",
    recordId: "ticket-8840",
    subject: "Missed collection at Adelgade 12",
    issue: "Missed collection",
    issueDetail: "SLA due in 38 min",
    impact: "High",
  },
  {
    id: "T-8831",
    recordId: "ticket-8831",
    subject: "Blocked access at Parkvej 18",
    issue: "Missed collection",
    issueDetail: "SLA due in 44 min",
    impact: "High",
  },
  {
    id: "T-8853",
    recordId: "ticket-8853",
    subject: "Overfilled container at Vennemindevej 14",
    issue: "Overflow",
    issueDetail: "SLA due in 52 min",
    impact: "High",
  },
  {
    id: "T-8842",
    recordId: "ticket-8842",
    subject: "Access note for Borgergade 41",
    issue: "Access issue",
    issueDetail: "SLA due in 1 h 12 min",
    impact: "Medium",
  },
]

// NordRen ApS route days on contract area CA-Ø-2 (Østerbro). RC-1048 is the
// same route day the operator sees — the contractor view is a scoped subset.
export const CONTRACTOR_ROUTE_PERFORMANCE_ROWS: RoutePerformanceRow[] = [
  {
    id: "RC-1052",
    name: "Østerbro Residual",
    area: "Østerbro N",
    serviceType: "Residual",
    stopsCompleted: 176,
    stopsPlanned: 238,
    onTimePercent: 64,
    proofComplete: 121,
    exceptions: 6,
    openTickets: 1,
    ticketSlaPercent: 68,
    slaPercent: 64,
    status: "At risk",
    issue: "SLA misses",
    issueDetail: "6 in last 7 days",
    trend: [78, 75, 73, 71, 70, 68, 66, 64],
  },
  {
    id: "RC-1048",
    name: "Østerbro Organic",
    area: "Østerbro",
    serviceType: "Organic",
    stopsCompleted: 512,
    stopsPlanned: 624,
    onTimePercent: 79,
    proofComplete: 466,
    exceptions: 4,
    openTickets: 1,
    ticketSlaPercent: 78,
    slaPercent: 79,
    status: "Monitor",
    issue: "Open exceptions",
    issueDetail: "4 exceptions",
    trend: [76, 78, 77, 80, 79, 81, 78, 79],
  },
  {
    id: "RC-1061",
    name: "Indre Østerbro Glass",
    area: "Indre Østerbro",
    serviceType: "Glass",
    stopsCompleted: 204,
    stopsPlanned: 246,
    onTimePercent: 81,
    proofComplete: 168,
    exceptions: 2,
    openTickets: 1,
    ticketSlaPercent: 82,
    slaPercent: 81,
    status: "Monitor",
    issue: "Proof incomplete",
    issueDetail: "36 stops",
    trend: [86, 85, 84, 83, 83, 82, 81, 81],
  },
  {
    id: "RC-1057",
    name: "Svanemøllen Paper",
    area: "Svanemøllen",
    serviceType: "Paper",
    stopsCompleted: 342,
    stopsPlanned: 358,
    onTimePercent: 94,
    proofComplete: 328,
    exceptions: 0,
    openTickets: 0,
    ticketSlaPercent: 96,
    slaPercent: 94,
    status: "On track",
    issue: "Stable service",
    issueDetail: "No action needed",
    trend: [88, 89, 90, 90, 91, 92, 93, 94],
  },
  {
    id: "RC-1064",
    name: "Ryvangen Cardboard",
    area: "Ryvangen",
    serviceType: "Cardboard",
    stopsCompleted: 288,
    stopsPlanned: 302,
    onTimePercent: 92,
    proofComplete: 274,
    exceptions: 1,
    openTickets: 0,
    ticketSlaPercent: 94,
    slaPercent: 92,
    status: "On track",
    issue: "Stable service",
    issueDetail: "No action needed",
    trend: [87, 88, 88, 89, 90, 91, 91, 92],
  },
  {
    id: "RC-1068",
    name: "Østerbro Bulky",
    area: "Østerbro S",
    serviceType: "Bulky",
    stopsCompleted: 122,
    stopsPlanned: 130,
    onTimePercent: 90,
    proofComplete: 118,
    exceptions: 0,
    openTickets: 0,
    ticketSlaPercent: 97,
    slaPercent: 90,
    status: "On track",
    issue: "Stable service",
    issueDetail: "No action needed",
    trend: [84, 85, 86, 86, 87, 88, 89, 90],
  },
]

// NordRen ApS open tickets; ticket-8831 is the same record the operator sees.
export const CONTRACTOR_TICKET_ATTENTION_ROWS: TicketAttentionRow[] = [
  {
    id: "T-8853",
    recordId: "ticket-8853",
    subject: "Overfilled container at Vennemindevej 14",
    issue: "Overflow",
    issueDetail: "SLA due in 52 min",
    impact: "High",
  },
  {
    id: "T-8831",
    recordId: "ticket-8831",
    subject: "Blocked access at Parkvej 18",
    issue: "Missed collection",
    issueDetail: "SLA due in 44 min",
    impact: "High",
  },
  {
    id: "T-8858",
    recordId: "ticket-8858",
    subject: "Missing proof photos at Strandboulevarden 92",
    issue: "Proof follow-up",
    issueDetail: "Due today",
    impact: "Medium",
  },
]

// Sums of CONTRACTOR_ROUTE_PERFORMANCE_ROWS; on-time = routes at ≥80%.
export const CONTRACTOR_PORTFOLIO_SUMMARY: PerformancePortfolioSummary = {
  onTimePercent: 67,
  onTimeRoutes: 4,
  totalRoutes: 6,
  completed: 1644,
  planned: 1898,
  openTickets: 3,
  ticketRouteCount: 3,
  resolvedWithinSla: 24,
  resolvedTotal: 27,
}

export const CONTRACTOR_THROUGHPUT_SERIES: ThroughputPoint[] =
  THROUGHPUT_SERIES.map((point) => ({
    date: point.date,
    completed: Math.round(point.completed * 0.36),
    previous: Math.max(34, Math.round(point.previous * 0.34)),
  }))
