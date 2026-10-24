"use client"

// The public map, loaded in the browser alone: MapLibre needs a window, and
// the list beside it is the page until it arrives.
import dynamic from "next/dynamic"

import type { MapPoint } from "@/lib/public/drop-off-points"

const DropOffMap = dynamic(() => import("./drop-off-map").then((module) => module.DropOffMap), { ssr: false })

export function DropOffMapLoader({ points, label }: { points: readonly MapPoint[]; label: string }) {
  return <DropOffMap points={points} label={label} />
}
