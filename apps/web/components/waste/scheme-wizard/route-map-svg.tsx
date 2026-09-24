"use client"

// The route map: an abstract block map with the departure depot bottom-left,
// the unloading station top-right, and one polyline per route through its
// stops. Stop positions come from the shared deterministic geometry
// (@waste/domain/route-schemes/map stopPosition), so the same container always
// lands on the same spot across the wizard and the scheme detail.

import { useMemo } from "react"

import { MAP_VIEWBOX, stopPosition } from "@waste/domain/route-schemes/map"
import { SERVICE_DAY_LABELS, type ServiceDay } from "@waste/domain/route-schemes/recurrence"

import type { WizardRoute } from "./wizard-model"

const W = 640
const H = 400
const DEPOT = { x: 52, y: H - 52 }
const STATION = { x: W - 58, y: 48 }
const STOP_AREA = { left: 60, right: W - 140, top: 40, bottom: H - 60 }

function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function toCanvas(containerId: string): [number, number] {
  const { x, y } = stopPosition(containerId)
  return [
    STOP_AREA.left + (x / MAP_VIEWBOX.width) * (STOP_AREA.right - STOP_AREA.left),
    STOP_AREA.top + (y / MAP_VIEWBOX.height) * (STOP_AREA.bottom - STOP_AREA.top),
  ]
}

export function RouteMapSvg({
  routes,
  selected,
  day,
  depotName,
  stationName,
}: {
  routes: readonly WizardRoute[]
  selected: string | null
  day: ServiceDay
  depotName: string
  stationName: string
}) {
  const blocks = useMemo(() => {
    const random = seededRandom(42)
    const out: { x: number; y: number; w: number; h: number }[] = []
    for (let y = 30; y < H - 40; y += 46) {
      for (let x = 40; x < W - 120; x += 58) {
        if (random() < 0.12) continue
        out.push({ x: x + random() * 6, y: y + random() * 6, w: 38 + random() * 12, h: 28 + random() * 10 })
      }
    }
    return out
  }, [])

  const paths = routes.map((route) => {
    const stops = route.plan.containerIds.map(toCanvas)
    const points: [number, number][] = [[DEPOT.x, DEPOT.y], ...stops, [STATION.x, STATION.y]]
    return {
      id: route.summary.group.id,
      color: route.summary.color,
      stops,
      d: points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(0)} ${y.toFixed(0)}`).join(" "),
    }
  })

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full bg-muted/40"
      role="img"
      aria-label={`Route preview for ${SERVICE_DAY_LABELS[day]}`}
    >
      <path
        d={`M${W - 110} 0 L${W} 0 L${W} ${H} L${W - 70} ${H} Q${W - 40} ${H / 2} ${W - 110} 0 Z`}
        className="fill-primary/10"
      />
      {blocks.map((block, index) => (
        <rect
          key={index}
          x={block.x}
          y={block.y}
          width={block.w}
          height={block.h}
          rx="4"
          className="fill-muted"
        />
      ))}
      {paths.map((path) => {
        const dim = selected !== null && selected !== path.id
        return (
          <g key={path.id} opacity={dim ? 0.2 : 1}>
            <path
              d={path.d}
              fill="none"
              stroke={path.color}
              strokeWidth={selected === path.id ? 3.5 : 2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {path.stops.map(([x, y], index) => (
              <circle
                key={index}
                cx={x}
                cy={y}
                r="3.5"
                className="fill-background"
                stroke={path.color}
                strokeWidth="2"
              />
            ))}
          </g>
        )
      })}
      <g transform={`translate(${DEPOT.x} ${DEPOT.y})`}>
        <circle r="9" className="fill-foreground" />
        <rect x="-4" y="-4" width="8" height="8" className="fill-background" />
      </g>
      <text x={DEPOT.x + 14} y={DEPOT.y + 4} fontSize="11" className="fill-foreground" fontFamily="inherit">
        {depotName}
      </text>
      <g transform={`translate(${STATION.x} ${STATION.y})`}>
        <circle r="9" className="fill-foreground" />
        <path d="M-4 4 L-4 -2 L0 -5 L4 -2 L4 4 Z" className="fill-background" />
      </g>
      <text
        x={STATION.x - 12}
        y={STATION.y + 4}
        fontSize="11"
        className="fill-foreground"
        textAnchor="end"
        fontFamily="inherit"
      >
        {stationName}
      </text>
    </svg>
  )
}
