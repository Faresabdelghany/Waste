// The streets the map-planning tests place things on. The shipping gazetteer
// is the web app's (apps/web/lib/data/street-gazetteer.ts, built beside the
// fixture registry it mirrors); the domain only knows the shape.
import type { Gazetteer } from "../positions"

export const TEST_GAZETTEER: Gazetteer = {
  ryesgade: { start: { lng: 12.5605, lat: 55.6905 }, bearing: 45 },
  blegdamsvej: { start: { lng: 12.5615, lat: 55.6935 }, bearing: 50 },
  jagtvej: { start: { lng: 12.5445, lat: 55.6935 }, bearing: 45 },
  amagerbrogade: { start: { lng: 12.5985, lat: 55.6685 }, bearing: 165 },
  sundkrogsgade: { start: { lng: 12.5905, lat: 55.7065 }, bearing: 40 },
  parkvej: { start: { lng: 12.5745, lat: 55.7025 }, bearing: 60 },
  "harbor offices": { start: { lng: 12.5975, lat: 55.7085 }, bearing: 60 },
}
