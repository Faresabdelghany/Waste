// The Layers control's base maps (2026-09-16): four keyless options — three
// OpenFreeMap vector styles and Esri's World Imagery raster for satellite.
// The swatch colours draw the thumbnails in CSS so the picker needs no
// network. The light and dark app themes pick the default until the user
// chooses. Pure data; components/waste/map-planning/planning-map.tsx
// hands the style to MapLibre.

export type BaseMapId = "streets" | "light" | "dark" | "satellite"

export type BaseMapSwatch = { land: string; water: string; road: string; text: string }

/** A MapLibre style: a style URL, or an inline raster style. */
export type BaseMapStyle =
  | string
  | {
      version: 8
      sources: Record<
        string,
        { type: "raster"; tiles: string[]; tileSize: number; attribution: string; maxzoom: number }
      >
      layers: Array<{ id: string; type: "raster"; source: string }>
    }

export type BaseMap = {
  id: BaseMapId
  label: string
  style: BaseMapStyle
  swatch: BaseMapSwatch
}

export const BASE_MAPS: readonly BaseMap[] = [
  {
    id: "streets",
    label: "Streets",
    style: "https://tiles.openfreemap.org/styles/liberty",
    swatch: { land: "#f3efe6", water: "#9fc8f2", road: "#ffffff", text: "#1f2937" },
  },
  {
    id: "light",
    label: "Light",
    style: "https://tiles.openfreemap.org/styles/positron",
    swatch: { land: "#f7f7f5", water: "#d3dbdd", road: "#ffffff", text: "#1f2937" },
  },
  {
    id: "dark",
    label: "Dark",
    style: "https://tiles.openfreemap.org/styles/dark",
    swatch: { land: "#1d2026", water: "#0f141c", road: "#3b4150", text: "#f4f4f5" },
  },
  {
    id: "satellite",
    label: "Satellite",
    style: {
      version: 8,
      sources: {
        satellite: {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution:
            "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        },
      },
      layers: [{ id: "satellite", type: "raster", source: "satellite" }],
    },
    swatch: { land: "#3f5a34", water: "#1f3a5f", road: "#8d907c", text: "#f4f4f5" },
  },
]

export const isBaseMapId = (value: unknown): value is BaseMapId =>
  typeof value === "string" && BASE_MAPS.some((map) => map.id === value)

export function defaultBaseMapForTheme(theme: "light" | "dark"): BaseMapId {
  return theme === "dark" ? "dark" : "streets"
}

export function baseMapById(id: BaseMapId): BaseMap {
  return BASE_MAPS.find((map) => map.id === id) ?? BASE_MAPS[0]
}
