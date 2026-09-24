// The quick form's driver choices: the domain's quickDriverOptions
// (@waste/domain/route-schemes/quick-create, issue #37) turned into form
// options — every driver listed, an ineligible one disabled with the reason
// beside the name, judged against the vehicle the form's plannedVehicleId
// names. The rule is the domain's; this file only spells the option shape.
import type { BusinessFormOption, BusinessFormValues } from "@/lib/data/business-form-types"
import { driverOptionLabel, type FleetRecord } from "@waste/domain/route-schemes/fleet-profiles"
import { quickDriverOptions } from "@waste/domain/route-schemes/quick-create"

export function driverFormOptions(
  values: Readonly<Partial<BusinessFormValues>>,
  drivers: readonly FleetRecord[],
  vehicles: readonly FleetRecord[],
): BusinessFormOption[] {
  return quickDriverOptions(values, drivers, vehicles).map(({ driver, eligible, reason }) => ({
    value: driver.id,
    label: reason ? `${driverOptionLabel(driver)} · ${reason}` : driverOptionLabel(driver),
    ...(eligible ? {} : { disabled: true }),
  }))
}
