// The register switch (#291 C13), the routing provider's (#131) in shape: one
// setting, ADDRESS_PROVIDER, read where env.ts reads everything else. The
// fake is the default — CI and the e2e lane never name anything else, since
// no key exists on the public repository — and `dataforsyningen` is the live
// register, which needs the owner's Dataforsyningen token: asked for it
// without one, the API refuses to start rather than answer every lookup 503.
import { DataforsyningenRegister } from "./dataforsyningen"
import { FakeAddressRegister } from "./fake"
import type { AddressRegister } from "./register"

export const ADDRESS_PROVIDER_VARIABLE = "ADDRESS_PROVIDER"
export const DATAFORSYNINGEN_TOKEN_VARIABLE = "DATAFORSYNINGEN_TOKEN"

const NAMES = ["fake", "dataforsyningen"] as const
export type AddressProviderName = (typeof NAMES)[number]

export type AddressRegisterSettings = { ADDRESS_PROVIDER?: string; DATAFORSYNINGEN_TOKEN?: string; ADDRESS_REGISTER_URL?: string }

/** The register the settings name, built; the fake where they name none. */
export function addressRegisterFrom(settings: AddressRegisterSettings): AddressRegister {
  const name = settings.ADDRESS_PROVIDER ?? "fake"
  if (!(NAMES as readonly string[]).includes(name)) {
    throw new Error(`${ADDRESS_PROVIDER_VARIABLE}=${name} names no address register here: "fake" and "dataforsyningen" are the ones that exist`)
  }
  if (name === "fake") return new FakeAddressRegister()
  const token = settings.DATAFORSYNINGEN_TOKEN?.trim()
  if (!token) throw new Error(`${ADDRESS_PROVIDER_VARIABLE}=dataforsyningen needs ${DATAFORSYNINGEN_TOKEN_VARIABLE}, the owner's Dataforsyningen token, in this process's environment`)
  return new DataforsyningenRegister({ token, ...(settings.ADDRESS_REGISTER_URL === undefined ? {} : { baseUrl: settings.ADDRESS_REGISTER_URL }) })
}
