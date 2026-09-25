// What the two fleet suites need of Resources beyond their own routes (Issue
// #101, slice 4): a vehicle type or two of the company, which a vehicle names,
// and a depot per project, which a vehicle and a driver are based at. The rows
// are written directly through `tx` as `wms_api` inside `withCompany`, the way
// tenant.ts seeds its company and scheme-fixtures.ts seeds Planning — the
// suites prove the vehicle and driver routes, not the type and depot ones,
// which are slice 3's — and `dropTenant` drops them with the rest of the
// company.
import type { Point } from "@waste/contracts/geojson"
import type { Database, Tx } from "@waste/db/client"
import { vehicleType } from "@waste/db/schema/fleet-types"
import { depot } from "@waste/db/schema/places"
import { withCompany } from "@waste/db/tenant"

import { testId, type Tenant } from "./tenant"

export type FleetFixtures = {
  /** Two vehicle types of the company. */
  vehicleTypes: { rearLoader: { id: string }; glassCrane: { id: string } }
  /** One depot in Copenhagen Central and one in Harbor Commercial, so a body can name the wrong project's. */
  depots: { nordhavn: { id: string }; harbor: { id: string } }
}

/** Copenhagen town hall, the point every located fixture here sits on. */
export const TOWN_HALL: Point = { type: "Point", coordinates: [12.5683, 55.6761] }

export async function seedFleet(pool: Database, tenant: Tenant): Promise<FleetFixtures> {
  const { companyId } = tenant
  const fixtures: FleetFixtures = {
    vehicleTypes: { rearLoader: { id: testId() }, glassCrane: { id: testId() } },
    depots: { nordhavn: { id: testId() }, harbor: { id: testId() } },
  }
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(vehicleType).values([
      { id: fixtures.vehicleTypes.rearLoader.id, companyId, key: "rear-loader", name: "Rear loader" },
      { id: fixtures.vehicleTypes.glassCrane.id, companyId, key: "glass-crane", name: "Glass crane" },
    ])
    await tx.insert(depot).values([
      {
        id: fixtures.depots.nordhavn.id,
        companyId,
        projectId: tenant.projects.copenhagen.id,
        code: "DEP-NORD",
        name: "Nordhavn",
        address: "Sundkrogsgade 1, 2100 København Ø",
        location: TOWN_HALL,
        ownership: "company",
        status: "active",
      },
      {
        id: fixtures.depots.harbor.id,
        companyId,
        projectId: tenant.projects.harbor.id,
        code: "DEP-HAVN",
        name: "Havnen",
        address: "Kalkbrænderihavnsgade 4, 2100 København Ø",
        location: TOWN_HALL,
        ownership: "company",
        status: "active",
      },
    ])
  })
  return fixtures
}
