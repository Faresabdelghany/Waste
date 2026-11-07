"use client"

// The public map of a project's Drop-off Points (Issue #293, M3b): a
// MapLibre base map with the points drawn on its canvas, one GeoJSON layer
// coloured by kind, framed to hold them all. A point clicked leads to its card
// in the list beside the map, which carries everything a resident reads and
// is the keyboard's way through them; the map adds where. Without JavaScript,
// or where the base map cannot load — the box is then taken away — the list
// is the page. Loaded client-only (drop-off-map-loader.tsx). North-up and
// flat like every map in the app (`useMapLibre`).
import type { ExpressionSpecification } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { useEffect, useRef } from "react"

import { useMapLibre } from "@/components/maps/use-maplibre"
import { boundsOf, pointAnchorOf, pointsCollectionOf, type MapPoint } from "@/lib/public/drop-off-points"

const FIT_PADDING_PX = 48
const FIT_MAX_ZOOM = 15
const SOURCE = "drop-off-points"
const LAYER = "drop-off-points"
/** A recycling centre's colour and a bring bank's; the card beside the map names the kind in words. */
const KIND_COLOURS: ExpressionSpecification = ["match", ["get", "kind"], "recycling-centre", "#2563eb", "#16a34a"]

/** The map of the points given, made afresh when they change, framed to hold them. */
export function DropOffMap({ points, label }: { points: readonly MapPoint[]; label: string }) {
  return <PointsMap key={points.map((point) => `${point.id}@${point.lng},${point.lat}`).join("|")} points={points} label={label} />
}

function PointsMap({ points, label }: { points: readonly MapPoint[]; label: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bounds = boundsOf(points)
  const { map, styleLoaded, baseMapFailed } = useMapLibre(containerRef, {
    baseMap: "streets",
    name: "drop-off-map",
    camera:
      bounds === null
        ? {}
        : {
            bounds: [
              [bounds.west, bounds.south],
              [bounds.east, bounds.north],
            ],
            fitBoundsOptions: { padding: FIT_PADDING_PX, maxZoom: FIT_MAX_ZOOM },
          },
  })

  useEffect(() => {
    if (map === null) return
    const draw = () => {
      if (map.getSource(SOURCE) !== undefined) return
      map.addSource(SOURCE, { type: "geojson", data: pointsCollectionOf(points) })
      map.addLayer({
        id: LAYER,
        type: "circle",
        source: SOURCE,
        paint: { "circle-radius": 7, "circle-color": KIND_COLOURS, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
      })
    }
    if (styleLoaded.current) draw()
    else map.once("load", draw)
    const open = (event: { features?: { properties?: Record<string, unknown> }[] }) => {
      const id = event.features?.[0]?.properties?.id
      if (typeof id === "string") window.location.hash = pointAnchorOf(id)
    }
    const pointing = () => {
      map.getCanvas().style.cursor = "pointer"
    }
    const leaving = () => {
      map.getCanvas().style.cursor = ""
    }
    map.on("click", LAYER, open)
    map.on("mouseenter", LAYER, pointing)
    map.on("mouseleave", LAYER, leaving)
    return () => {
      map.off("load", draw)
      map.off("click", LAYER, open)
      map.off("mouseenter", LAYER, pointing)
      map.off("mouseleave", LAYER, leaving)
    }
  }, [map, points, styleLoaded])

  // A base map that never loads (offline, blocked tiles) leaves an empty box: it is taken away, and the list is the page.
  if (baseMapFailed) return null
  return <div ref={containerRef} role="region" aria-label={label} className="h-72 w-full overflow-hidden rounded-lg border border-border sm:h-96 print:hidden" />
}
