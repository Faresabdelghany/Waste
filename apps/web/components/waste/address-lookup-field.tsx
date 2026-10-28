"use client"
// The address picker of a property's form on the Pilot (#291 C13): a search of
// the national address register through the API (`GET /addresses?q=`, then
// `GET /addresses/:id` for the address picked), whose key stays on the
// server. A pick hands the dialog the values `addressPicked` spells
// (lib/data/address-lookup.ts); the field's own value is the register's id,
// which the property's write names instead of the typed text. Where the
// register does not answer, or finds nothing, the form is whole without it:
// the address typed and the point placed by hand. The register's data is
// credited under the field, as its licence asks.
import { useEffect, useState } from "react"
import { MagnifyingGlass, MapPin, X } from "@phosphor-icons/react/dist/ssr"
import type { Address, AddressSearch } from "@waste/contracts/addresses"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useApiClient } from "@/components/waste/api-session-store"
import { addressPicked } from "@/lib/data/address-lookup"
import type { BusinessFormField, BusinessFormValues } from "@/lib/data/business-form-types"
import { get, withQuery } from "@/lib/api/client"
import { ApiProblem } from "@/lib/api/problem"

/** How long the typing rests before the register is asked, and the fewest characters it is asked with (`ADDRESS_QUERY_MIN`). */
const SEARCH_DELAY_MS = 250
const QUERY_MIN = 2

type Found = { kind: "idle" } | { kind: "searching" } | { kind: "found"; search: AddressSearch } | { kind: "failed"; sentence: string }

const failedSentence = (error: unknown) =>
  error instanceof ApiProblem && error.problem.detail ? error.problem.detail : "The address register could not be asked. Type the address and place the point by hand."

export function AddressLookupField({
  field,
  values,
  onPick,
  onLetGo,
}: {
  field: BusinessFormField
  values: BusinessFormValues
  /** The values a pick sets. */
  onPick: (picked: BusinessFormValues) => void
  /** The pick let go: the address stays as it reads, now the office's own. */
  onLetGo: () => void
}) {
  const client = useApiClient()
  const [text, setText] = useState("")
  const [found, setFound] = useState<Found>({ kind: "idle" })
  const [picking, setPicking] = useState(false)
  const picked = typeof values[field.id] === "string" && values[field.id] !== ""
  const query = text.trim()

  useEffect(() => {
    if (client === null || query.length < QUERY_MIN) return
    let current = true
    const timer = setTimeout(() => {
      setFound({ kind: "searching" })
      get<AddressSearch>(client, withQuery("/addresses", { q: query }))
        .then((search) => current && setFound({ kind: "found", search }))
        .catch((error: unknown) => current && setFound({ kind: "failed", sentence: failedSentence(error) }))
    }, SEARCH_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [client, query])

  if (client === null || field.addressLookup === undefined) return null
  const fields = field.addressLookup

  const pick = (id: string) => {
    setPicking(true)
    get<Address>(client, `/addresses/${encodeURIComponent(id)}`)
      .then((address) => {
        onPick(addressPicked(field.id, fields, address, values))
        setText("")
        setFound({ kind: "idle" })
      })
      .catch((error: unknown) => setFound({ kind: "failed", sentence: failedSentence(error) }))
      .finally(() => setPicking(false))
  }

  const shown = query.length < QUERY_MIN ? null : found
  return (
    <div className="grid gap-2" data-testid="address-lookup">
      {picked ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" weight="fill" />
            <span>
              Found in the address register
              <span className="block text-xs text-muted-foreground">Typing over the service address makes it your own again.</span>
            </span>
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onLetGo} aria-label="Let the register's address go">
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={`business-form-${field.id}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={field.placeholder ?? "Street and number, then pick the address"}
            className="pl-9"
            autoComplete="off"
            disabled={picking}
          />
        </div>
      )}
      {!picked && shown?.kind === "searching" && <p className="text-xs text-muted-foreground">Searching the address register…</p>}
      {!picked && shown?.kind === "failed" && <p className="text-xs text-destructive">{shown.sentence}</p>}
      {!picked && shown?.kind === "found" && shown.search.items.length === 0 && (
        <p className="text-xs text-muted-foreground">No address in the register begins so. Type the address below and place the point by hand.</p>
      )}
      {!picked && shown?.kind === "found" && shown.search.items.length > 0 && (
        <ul className="grid gap-1 rounded-md border border-border p-1" role="listbox" aria-label="Addresses found">
          {shown.search.items.map((match) => (
            <li key={match.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                disabled={picking}
                onClick={() => pick(match.id)}
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                {match.designation}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(picked || shown?.kind === "found") && <p className="text-[11px] text-muted-foreground">{shown?.kind === "found" ? shown.search.attribution : "Indeholder data fra Klimadatastyrelsen, CC BY 4.0"}</p>}
    </div>
  )
}
