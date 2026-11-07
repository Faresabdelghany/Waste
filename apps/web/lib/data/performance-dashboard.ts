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

const CURRENT_PERIOD_VALUES = [
  128, 154, 172, 149, 188, 205, 167, 143, 132, 156,
  176, 201, 184, 165, 147, 139, 158, 193, 219, 205,
  237, 254, 221, 232, 243, 214, 193, 204, 221, 191,
]

const THROUGHPUT_SERIES: ThroughputPoint[] = CURRENT_PERIOD_VALUES.map(
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

// NordRen ApS route days on service area CA-Ø-2 (Østerbro).
export const SERVICE_PROVIDER_ROUTE_PERFORMANCE_ROWS: RoutePerformanceRow[] = [
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
  },
]

// NordRen ApS open tickets; each recordId is a Tickets module fixture.
export const SERVICE_PROVIDER_TICKET_ATTENTION_ROWS: TicketAttentionRow[] = [
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

// Sums of SERVICE_PROVIDER_ROUTE_PERFORMANCE_ROWS; on-time = routes at ≥80%.
export const SERVICE_PROVIDER_PORTFOLIO_SUMMARY: PerformancePortfolioSummary = {
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

export const SERVICE_PROVIDER_THROUGHPUT_SERIES: ThroughputPoint[] =
  THROUGHPUT_SERIES.map((point) => ({
    date: point.date,
    completed: Math.round(point.completed * 0.36),
    previous: Math.max(34, Math.round(point.previous * 0.34)),
  }))
