// Where the fixture streets are (2026-09-16, moved here from @waste/domain
// by issue #58). Container and property fixtures carry no coordinates, so
// the map derives a position from the address through
// @waste/domain/map-planning/positions, which places an address only on a
// street this table lists. The table mirrors the registry beside it:
// SEEDED_COPENHAGEN_STREETS and SEEDED_HARBOR_STREETS in business-modules.ts
// plus the explicit container fixtures, and it decides which fixture route
// days the Routes layer can draw (a pickup at no registry container is placed
// by its address only on a listed street). Keys are lower-cased street names
// as the domain parses them;
// anchors are approximate real coordinates of the low-number end, with the
// bearing the numbers grow along — the picture only has to be plausible and
// stable. lib/data/__tests__/street-gazetteer.test.ts holds this table and
// the registry together: a fixture street without an anchor fails there.
import type { Gazetteer } from "@waste/domain/map-planning/positions"

export const FIXTURE_GAZETTEER: Gazetteer = {
  ryesgade: { start: { lng: 12.5605, lat: 55.6905 }, bearing: 45 },
  blegdamsvej: { start: { lng: 12.5615, lat: 55.6935 }, bearing: 50 },
  jagtvej: { start: { lng: 12.5445, lat: 55.6935 }, bearing: 45 },
  amagerbrogade: { start: { lng: 12.5985, lat: 55.6685 }, bearing: 165 },
  istedgade: { start: { lng: 12.5615, lat: 55.6725 }, bearing: 250 },
  "godthåbsvej": { start: { lng: 12.5405, lat: 55.6865 }, bearing: 260 },
  "falkoner allé": { start: { lng: 12.5335, lat: 55.6765 }, bearing: 10 },
  strandboulevarden: { start: { lng: 12.5865, lat: 55.7105 }, bearing: 200 },
  tagensvej: { start: { lng: 12.5575, lat: 55.6975 }, bearing: 320 },
  enghavevej: { start: { lng: 12.5475, lat: 55.6705 }, bearing: 180 },
  "østerbrogade": { start: { lng: 12.5735, lat: 55.6975 }, bearing: 30 },
  "vigerslev allé": { start: { lng: 12.5195, lat: 55.6595 }, bearing: 265 },
  sandkaj: { start: { lng: 12.5965, lat: 55.7085 }, bearing: 60 },
  orientkaj: { start: { lng: 12.6025, lat: 55.7115 }, bearing: 70 },
  sundkrogsgade: { start: { lng: 12.5905, lat: 55.7065 }, bearing: 40 },
  trelleborggade: { start: { lng: 12.5985, lat: 55.7125 }, bearing: 90 },
  helsinkigade: { start: { lng: 12.6005, lat: 55.7095 }, bearing: 80 },
  parkvej: { start: { lng: 12.5745, lat: 55.7025 }, bearing: 60 },
  sundbyvej: { start: { lng: 12.6035, lat: 55.6575 }, bearing: 100 },
  "nørrebrogade": { start: { lng: 12.5565, lat: 55.6865 }, bearing: 315 },
  vesterbrogade: { start: { lng: 12.5655, lat: 55.6745 }, bearing: 245 },
  "harbor offices": { start: { lng: 12.5975, lat: 55.7085 }, bearing: 60 },
}
