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
  slaPercent: number
  status: RouteHealthStatus
  issue: string
  issueDetail: string
  trend: number[]
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

export const THROUGHPUT_SERIES = CURRENT_PERIOD_VALUES.map((completed, index) => {
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
})
