"use client"

import dynamic from "next/dynamic"

import {
  CONTRACTOR_PORTFOLIO_SUMMARY,
  CONTRACTOR_PRIORITY_ATTENTION_IDS,
  CONTRACTOR_ROUTE_PERFORMANCE_ROWS,
  CONTRACTOR_THROUGHPUT_SERIES,
} from "@/lib/data/performance-dashboard"

const PerformanceControlRoom = dynamic(
  () =>
    import("@/components/performance-control-room").then(
      (module) => module.PerformanceControlRoom,
    ),
  { ssr: false },
)

// The operator's Route performance control room, scoped to NordRen ApS —
// same layout and interactions, contractor-only routes and totals.
export function ContractorDashboard() {
  return (
    <PerformanceControlRoom
      breadcrumbLabel="Dashboard"
      subtitle="NordRen ApS · Contract area CA-Ø-2"
      scopeOptions={[{ value: "ca-o-2", label: "Contract area CA-Ø-2" }]}
      rows={CONTRACTOR_ROUTE_PERFORMANCE_ROWS}
      series={CONTRACTOR_THROUGHPUT_SERIES}
      summary={CONTRACTOR_PORTFOLIO_SUMMARY}
      priorityAttentionIds={CONTRACTOR_PRIORITY_ATTENTION_IDS}
    />
  )
}
