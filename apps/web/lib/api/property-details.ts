// What a property's details — and a shared point's — ask the client
// themselves, apart from its record: its notification zones (O29 of #290),
// its Pickup Exceptions (M5 of #293), its move (#374) and its tanks with their
// inspections (M11 of #293). None is a row of a workspace's table, so none is
// a switched module; the sentences each is told in are lib/data's
// (property-zones.ts, pickup-exception-history.ts, property-moves.ts, tanks.ts).
import type { MoveCreate, MoveOutcome } from "@waste/contracts/moves"
import type { PickupExceptionHistory } from "@waste/contracts/pickup-exceptions"
import type { PlanningAreasAt } from "@waste/contracts/planning-areas"
import type { TankInspection, TankInspectionCreate, TankInstallation, TankInstallationCreate, TankInstallationPatch } from "@waste/contracts/tanks"

import type { ExceptionPlace } from "@/lib/data/pickup-exception-history"

import { command, create, get, listAll, patch, type ApiClient } from "./client"

/** The property's zones today, as the one row `useRowHistory` reads. */
export const propertyZones = (client: ApiClient, serverId: string): Promise<PlanningAreasAt[]> => get<PlanningAreasAt>(client, `/properties/${serverId}/zones`).then((zones) => [zones])

/** The path each place kind's history is under. */
const PLACE_PATHS: Readonly<Record<ExceptionPlace, string>> = { property: "/properties", "shared-point": "/shared-collection-points" }

/** The place's history, as the one row `useRowHistory` reads. */
export const placePickupExceptions = (place: ExceptionPlace) => (client: ApiClient, serverId: string): Promise<PickupExceptionHistory[]> =>
  get<PickupExceptionHistory>(client, `${PLACE_PATHS[place]}/${serverId}/pickup-exceptions`).then((history) => [history])

/** The move, or its dry run: the API's answer either way. */
export const moveProperty = (client: ApiClient, propertyServerId: string, body: MoveCreate): Promise<MoveOutcome> => command<MoveOutcome>(client, `/properties/${propertyServerId}/moves`, body)

/** A Property's tanks, every one, oldest first: a property has a handful. */
export const tanksOfProperty = (client: ApiClient, propertyServerId: string): Promise<TankInstallation[]> => listAll<TankInstallation>(client, "/tank-installations", { propertyId: propertyServerId })

/** A tank's inspections, oldest first. */
export const inspectionsOf = (client: ApiClient, tankId: string): Promise<TankInspection[]> => listAll<TankInspection>(client, `/tank-installations/${tankId}/inspections`)

export const registerTank = async (client: ApiClient, body: TankInstallationCreate): Promise<TankInstallation> => (await create<TankInstallation>(client, "/tank-installations", body)).body

export const changeTank = (client: ApiClient, tankId: string, body: TankInstallationPatch): Promise<TankInstallation> => patch<TankInstallation>(client, `/tank-installations/${tankId}`, body)

export const recordInspection = (client: ApiClient, tankId: string, body: TankInspectionCreate): Promise<TankInspection> => command<TankInspection>(client, `/tank-installations/${tankId}/inspections`, body)
