"use client"

import dynamic from "next/dynamic"

const PerformancePage = dynamic(
  () => import("@/components/performance-page").then((module) => module.PerformancePage),
  { ssr: false },
)

export default function Page() {
  return <PerformancePage />
}
