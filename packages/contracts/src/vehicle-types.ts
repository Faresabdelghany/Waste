// The Vehicle Type on the wire (Issue #101): a company's row, not a token of
// the code's — one company's "Rear loader" is another's "Baglæsser", the
// reasoning that made a waste fraction a row — carrying the compatibility
// Planning's stop matching applies: the container types a vehicle of this
// type may service. Planning's `StopMatchVehicleType` token retired with it,
// and a Stop Matching Rule names a vehicle type by id.
//
// The `key` is the stable slug the rest of the system quotes (`rear-loader`),
// held to the one key shape of text.ts (`Slug`, as a waste fraction's — its
// bound is `KEY_MAX`, 50, where slice 2 first said 64; pre-release, with no
// key stored anywhere, one bound for every key is the better rule) and set once:
// the patch takes the name and the description and never the key, since a
// rule or an import that quotes the old one goes on quoting it, and a type
// that needs another key is another type. The compatibility set travels with
// the record and is replaced whole through `PUT /vehicle-types/:id/container-types`,
// the way a property's parties are; a create may carry the set it starts
// with, a patch never does. The set body is bounded and distinct, the
// resource unbounded, since a set already stored has to read back however
// long it grew.
import * as z from "zod"

import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { changesSomething, eachOnce, eachOnceSentence, somethingToChange, stamped } from "./resource"
import { Label, Paragraph, Slug } from "./text"

/** The most container types a set body may name: a form's list, not an import. */
const SET_MAX = 200

/** The stable key, `rear-loader`: the one key shape of text.ts, as a waste fraction's. */
const VehicleTypeKey = Slug()

export const EACH_CONTAINER_TYPE_ONCE = eachOnceSentence("container type")
const eachContainerTypeOnce = { message: EACH_CONTAINER_TYPE_ONCE, path: ["containerTypeIds"] }

const ContainerTypeIds = z.array(Id)
const ContainerTypeIdsBody = ContainerTypeIds.max(SET_MAX)

export const VehicleType = z.object({
  ...stamped,
  /** The stable slug the rest of the system quotes: `rear-loader`. Unique per company; set once. */
  key: VehicleTypeKey,
  /** What a person reads: `Rear loader`. Unique per company. */
  name: Label,
  description: Paragraph.nullable(),
  /** The container types a vehicle of this type may service, by id; replaced whole through its own route. */
  containerTypeIds: ContainerTypeIds,
})
export type VehicleType = z.infer<typeof VehicleType>

export const VehicleTypeCreate = z
  .strictObject({
    key: VehicleTypeKey,
    name: Label,
    description: Paragraph.nullable().optional(),
    containerTypeIds: ContainerTypeIdsBody.default([]).describe("The container types the vehicle type starts out servicing; none when absent, and then no typed rule matches through it."),
  })
  .refine((body) => eachOnce(body.containerTypeIds), eachContainerTypeOnce)
export type VehicleTypeCreate = z.infer<typeof VehicleTypeCreate>

/** The name and the description; the key is the slug the rest of the system quotes, and the compatibility set has a route of its own. */
export const VehicleTypePatch = z
  .strictObject({
    name: Label.optional(),
    description: Paragraph.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type VehicleTypePatch = z.infer<typeof VehicleTypePatch>

/** The whole compatibility set, replacing what the type had. An empty set is a type no typed rule matches through. */
export const VehicleTypeContainerTypesSet = z.strictObject({ containerTypeIds: ContainerTypeIdsBody }).refine((body) => eachOnce(body.containerTypeIds), eachContainerTypeOnce)
export type VehicleTypeContainerTypesSet = z.infer<typeof VehicleTypeContainerTypesSet>

/** A page of vehicle types: the company's, so the page is the only parameter. */
export const VehicleTypeListQuery = PageRequest
export type VehicleTypeListQuery = z.infer<typeof VehicleTypeListQuery>
