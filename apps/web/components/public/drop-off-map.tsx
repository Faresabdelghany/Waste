"use client"

// The public map of a project's Drop-off Points (Issue #293, M3b): a
// MapLibre base map with the points drawn on its canvas, one GeoJSON layer
// coloured by kind, framed to hold them all. A point clicked leads to its card
// in the list beside the map, which carries everything a resident reads and
// is the keyboard's way through them; the map adds where. Without JavaScript,
// or where the base map cannot load — the box is then taken away — the list
// is the page. Loaded client-only (drop-off-map-loader.tsx). North-up and
// flat like every map in the app.
import { Map as MapLibreMap, NavigationControl, type ExpressionSpecification, type StyleSpecification } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { useEffect, useRef, useState } from "react"

import { pointMapLibreWorkerAtRouteHandler } from "@/components/waste/map-planning/maplibre-worker"
import { baseMapById } from "@/lib/map-planning/base-maps"
import { boundsOf, pointAnchorOf, pointsCollectionOf, type MapPoint } from "@/lib/public/drop-off-points"

// The tile worker's URL, see maplibre-worker.ts — set before the first Map.
pointMapLibreWorkerAtRouteHandler()

const FIT_PADDING_PX = 48
const FIT_MAX_ZOOM = 15
const SOURCE = "drop-off-points"
const LAYER = "drop-off-points"
/** A recycling centre's colour and a bring bank's; the card beside the map names the kind in words. */
const KIND_COLOURS: ExpressionSpecification = ["match", ["get", "kind"], "recycling-centre", "#2563eb", "#16a34a"]

export function DropOffMap({ points, label }: { points: readonly MapPoint[]; label: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    const bounds = boundsOf(points)
    if (!container || bounds === null) return
    let loaded = false
    const map = new MapLibreMap({
      container,
      style: baseMapById("streets").style as string | StyleSpecification,
      bounds: [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      fitBoundsOptions: { padding: FIT_PADDING_PX, maxZoom: FIT_MAX_ZOOM },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    })
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    map.addControl(new NavigationControl({ showCompass: false }), "top-right")
    map.on("load", () => {
      loaded = true
      container.dataset.mapLoaded = "true"
      map.addSource(SOURCE, { type: "geojson", data: pointsCollectionOf(points) })
      map.addLayer({
        id: LAYER,
        type: "circle",
        source: SOURCE,
        paint: { "circle-radius": 7, "circle-color": KIND_COLOURS, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
      })
    })
    map.on("click", LAYER, (event) => {
      const id = event.features?.[0]?.properties?.id
      if (typeof id === "string") window.location.hash = pointAnchorOf(id)
    })
    map.on("mouseenter", LAYER, () => {
      map.getCanvas().style.cursor = "pointer"
    })
    map.on("mouseleave", LAYER, () => {
      map.getCanvas().style.cursor = ""
    })
    // A base map that never loads (offline, blocked tiles) leaves an empty box: take it away, the list is the page.
    map.on("error", () => {
      if (!loaded) setFailed(true)
    })
    return () => map.remove()
  }, [points])

  if (failed) return null
  return <div ref={containerRef} role="region" aria-label={label} className="h-72 w-full overflow-hidden rounded-lg border border-border sm:h-96 print:hidden" />
}
