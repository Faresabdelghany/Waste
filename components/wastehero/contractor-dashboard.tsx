"use client"

import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"

import {
  CONTRACTOR_PORTFOLIO_SUMMARY,
  CONTRACTOR_ROUTE_PERFORMANCE_ROWS,
  CONTRACTOR_THROUGHPUT_SERIES,
  CONTRACTOR_TICKET_ATTENTION_ROWS,
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
  const router = useRouter()

  // Dashboard rows use route codes (RC-1048); route records use ids (route-day-1048).
  const openRoute = (routeId: string) => {
    const recordId = `route-day-${routeId.replace(/^RC-/, "")}`
    router.push(`/contractor-workspace/routes?module=routes&record=${recordId}`)
  }

  return (
    <PerformanceControlRoom
      breadcrumbLabel="Dashboard"
      subtitle="NordRen ApS · Contract area CA-Ø-2"
      scopeOptions={[{ value: "ca-o-2", label: "Contract area CA-Ø-2" }]}
      rows={CONTRACTOR_ROUTE_PERFORMANCE_ROWS}
      series={CONTRACTOR_THROUGHPUT_SERIES}
      summary={CONTRACTOR_PORTFOLIO_SUMMARY}
      tickets={CONTRACTOR_TICKET_ATTENTION_ROWS}
      ticketsBasePath="/contractor-workspace/tickets"
      hideTableColumns={["proof", "exceptions", "trend"]}
      onRouteOpen={openRoute}
    />
  )
}
