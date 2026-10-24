import type { Metadata } from "next"

import { ImportsPage } from "@/components/imports/imports-page"

// Improve › Imports (#291 slice 12).
export const instant = false

export const metadata: Metadata = {
  title: "Imports · Waste",
}

export default function Page() {
  return <ImportsPage />
}
