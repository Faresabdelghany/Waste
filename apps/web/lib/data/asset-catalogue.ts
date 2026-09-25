// The fixture asset catalogue's container types (Issue #39, 2026-09-25):
// the seed of Settings › Asset management, pulled out of the store so the
// tests can hold it against the fixture registry without React. Every
// display type the registry seeds is weighed here for every fraction the
// fixtures put in it, and timed, because the guided setup's estimates read
// this catalogue first and fall back to the prototype's table only for a
// pair it does not weigh (@waste/domain/route-schemes/estimates) — before
// Issue #39 the 140 L bin, the igloo and the underground unit were not here
// at all, and the four that were weighed one to three fractions each, so
// most groups carried "Fallback weight". Weights are one emptying of the
// type per fraction in kg: the numbers the catalogue already had are kept,
// the rest derived from each type's residual weight by the fraction density
// factors the fallback table uses (organic 1.2, paper 0.6, cardboard 0.5,
// glass 1.5, plastic 0.3, metal 0.8, mixed 1). Emptying times are minutes.
// Planning defaults the Settings pane can correct; the store persists what
// the browser holds and seeds from here on a first visit.
// lib/data/__tests__/asset-catalogue.test.ts holds this table to the registry.

export type LifecycleStatus = "Active" | "Inactive"
export type ContainerKind = "waste-collection" | "wastewater"

export type ContainerType = {
  id: string
  name: string
  kind: ContainerKind
  projectIds: string[]
  emplacement: string
  vehicleCoupling: string
  emptyingTimeMinutes: number
  customizeEmptyingTime: boolean
  emptyingTimeSeconds: number
  volumePreset: string
  volume: number
  volumeUnit: "L" | "m³"
  cylinderShape: boolean
  heightCm: number
  lengthCm: number
  widthCm: number
  diameterCm: number
  /** kg for one emptying of the type, by waste fraction id (lower-case name). */
  wasteFractionWeights: Record<string, number>
  color: string
  icon: string
  lidType: string
  loadingMethod: string
  warrantyMonths: number
  lifecycleStatus: LifecycleStatus
  createdAt: string
  updatedAt: string
}

export const FIXTURE_CREATED_AT = "2026-01-01T00:00:00.000Z"

const fixtureCreatedAt = FIXTURE_CREATED_AT

export const FIXTURE_CONTAINER_TYPES: readonly ContainerType[] = [
    {
      id: "two-wheel-240",
      name: "Two-wheel bin · 240 L",
      kind: "waste-collection",
      projectIds: [],
      emplacement: "Surface",
      vehicleCoupling: "Comb lift",
      emptyingTimeMinutes: 2,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "240 L",
      volume: 240,
      volumeUnit: "L",
      cylinderShape: false,
      heightCm: 107,
      lengthCm: 74,
      widthCm: 58,
      diameterCm: 0,
      wasteFractionWeights: { residual: 18, organic: 22, paper: 12, cardboard: 9, glass: 27, plastic: 5, metal: 14, mixed: 18 },
      color: "#2563eb",
      icon: "bin",
      lidType: "Hinged",
      loadingMethod: "Rear loader",
      warrantyMonths: 60,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "four-wheel-660",
      name: "Four-wheel bin · 660 L",
      kind: "waste-collection",
      projectIds: [],
      emplacement: "Surface",
      vehicleCoupling: "DIN trunnion",
      emptyingTimeMinutes: 3,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "660 L",
      volume: 660,
      volumeUnit: "L",
      cylinderShape: false,
      heightCm: 122,
      lengthCm: 137,
      widthCm: 78,
      diameterCm: 0,
      wasteFractionWeights: { residual: 49, organic: 59, paper: 29, cardboard: 25, glass: 74, plastic: 15, metal: 39, mixed: 45 },
      color: "#0f766e",
      icon: "dumpster",
      lidType: "Flat",
      loadingMethod: "Rear loader",
      warrantyMonths: 60,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "four-wheel-1100",
      name: "Four-wheel bin · 1,100 L",
      kind: "waste-collection",
      projectIds: [],
      emplacement: "Surface",
      vehicleCoupling: "DIN trunnion",
      emptyingTimeMinutes: 4,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "1,100 L",
      volume: 1100,
      volumeUnit: "L",
      cylinderShape: false,
      heightCm: 147,
      lengthCm: 137,
      widthCm: 107,
      diameterCm: 0,
      wasteFractionWeights: { residual: 75, organic: 90, paper: 45, cardboard: 58, glass: 113, plastic: 23, metal: 60, mixed: 75 },
      color: "#475569",
      icon: "dumpster",
      lidType: "Domed",
      loadingMethod: "Rear loader",
      warrantyMonths: 72,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    // The three display types the fixture registry seeds that the catalogue
    // did not weigh (Issue #39): the estimate's fallback table covered them,
    // so every kerbside, crane and underground group carried "Fallback
    // weight". Weights are one emptying of the type per fraction, kg — the
    // 140 L as the 240 L's kerbside sibling, the igloo and the underground
    // unit as glass-first crane work — as the rest of the catalogue records
    // them: a planning default the Settings pane can correct.
    {
      id: "two-wheel-140",
      name: "Two-wheel bin · 140 L",
      kind: "waste-collection",
      projectIds: [],
      emplacement: "Surface",
      vehicleCoupling: "Comb lift",
      emptyingTimeMinutes: 2,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "Custom",
      volume: 140,
      volumeUnit: "L",
      cylinderShape: false,
      heightCm: 106,
      lengthCm: 55,
      widthCm: 48,
      diameterCm: 0,
      wasteFractionWeights: { residual: 11, organic: 13, paper: 7, cardboard: 6, glass: 17, plastic: 4, metal: 9, mixed: 11 },
      color: "#1d4ed8",
      icon: "bin",
      lidType: "Hinged",
      loadingMethod: "Rear loader",
      warrantyMonths: 60,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "igloo-2500",
      name: "Igloo · 2,500 L",
      kind: "waste-collection",
      projectIds: [],
      emplacement: "Surface",
      vehicleCoupling: "Crane hook",
      emptyingTimeMinutes: 6,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "Custom",
      volume: 2500,
      volumeUnit: "L",
      cylinderShape: true,
      heightCm: 165,
      lengthCm: 0,
      widthCm: 0,
      diameterCm: 180,
      wasteFractionWeights: { residual: 400, organic: 480, paper: 240, cardboard: 200, glass: 600, plastic: 120, metal: 320, mixed: 400 },
      color: "#0e7490",
      icon: "igloo",
      lidType: "Drop slot",
      loadingMethod: "Crane",
      warrantyMonths: 120,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "underground-5000",
      name: "Underground · 5,000 L",
      kind: "waste-collection",
      projectIds: [],
      emplacement: "Underground",
      vehicleCoupling: "Crane hook",
      emptyingTimeMinutes: 8,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "Custom",
      volume: 5000,
      volumeUnit: "L",
      cylinderShape: false,
      heightCm: 260,
      lengthCm: 200,
      widthCm: 150,
      diameterCm: 0,
      wasteFractionWeights: { residual: 650, organic: 780, paper: 390, cardboard: 325, glass: 975, plastic: 195, metal: 520, mixed: 650 },
      color: "#334155",
      icon: "underground",
      lidType: "Pillar insert",
      loadingMethod: "Crane",
      warrantyMonths: 180,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "wastewater-3000",
      name: "Wastewater tank · 3,000 L",
      kind: "wastewater",
      projectIds: [],
      emplacement: "Underground",
      vehicleCoupling: "Suction hose",
      emptyingTimeMinutes: 18,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "3,000 L",
      volume: 3000,
      volumeUnit: "L",
      cylinderShape: true,
      heightCm: 220,
      lengthCm: 0,
      widthCm: 0,
      diameterCm: 140,
      wasteFractionWeights: { wastewater: 3000 },
      color: "#0891b2",
      icon: "tank",
      lidType: "Inspection cover",
      loadingMethod: "Vacuum",
      warrantyMonths: 120,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
]