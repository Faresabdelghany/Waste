// The quick form's driver choices, built on the domain's eligibility rule
// (@waste/domain/route-schemes/fleet-profiles): every driver is listed, and
// an ineligible one is disabled with the reason beside the name.
import type { BusinessFormOption } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import {
  driverOptionLabel,
  driverOptions,
  driverProfile,
  vehicleProfile,
} from "@waste/domain/route-schemes/fleet-profiles"

type RecordLike = Pick<BusinessRecord, "id" | "name" | "context" | "facts" | "submittedValues">

export function driverFormOptions(
  drivers: readonly RecordLike[],
  vehicle: RecordLike | undefined,
): BusinessFormOption[] {
  return driverOptions(drivers.map(driverProfile), vehicle ? vehicleProfile(vehicle) : null).map(
    ({ driver, eligible, reason }) => ({
      value: driver.id,
      label: reason ? `${driverOptionLabel(driver)} · ${reason}` : driverOptionLabel(driver),
      ...(eligible ? {} : { disabled: true }),
    }),
  )
}
