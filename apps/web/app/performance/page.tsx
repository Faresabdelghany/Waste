"use client"

import dynamic from "next/dynamic"

const DashboardPage = dynamic(
  () => import("@/components/insight/dashboard-page").then((module) => module.DashboardPage),
  { ssr: false },
)

export default function Page() {
  return <DashboardPage />
}
