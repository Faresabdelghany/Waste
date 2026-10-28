"use client"

// The attendant's check-in (#393, M4 of #293): a phone-first page of its
// own, where a Site attendant lands (`landingOf`), with none of the office's
// navigation. The recycling centre is picked once and remembered on the
// device (`CHECK_IN_SITE_STORAGE_KEY`); a visitor is identified by a plate or
// a card typed, or by a Property found by its address; the fractions brought
// are chips of the ones the site takes; and the answer card says what the
// API recorded — admitted or turned away and why, and for an admitted visit
// what it costs: "3rd visit this year: 70,00 kr". Nothing is decided here:
// the outcome, the count and the price are the API's (`POST /site-visits`).
// The reads are `/site-visits/sites` and `/site-visits/addresses`, under
// `operate.site-visits`, so the attendant needs no grant on the places or the
// master data. The words are lib/data/site-visits.ts'.
import Link from "next/link"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { CheckCircle, MagnifyingGlass, Recycle, SignOut, XCircle } from "@phosphor-icons/react/dist/ssr"

import type { SiteVisitCheckInAnswer, VisitAddress, VisitSite } from "@waste/contracts/site-visits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { allows } from "@/lib/api/grants"
import { SIGN_IN_PATH } from "@/lib/api/landing"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { checkInVisit, readVisitSites, searchVisitAddresses } from "@/lib/api/site-visits"
import { BLOCK_REASON_LABELS } from "@/lib/data/commercial"
import { ADDRESS_QUERY_MIN, answerHeadline, chargeSentence, CHECK_IN_MODES, CHECK_IN_PATH, checkInBodyOf, rememberedSite, toggled, type CheckInMode } from "@/lib/data/site-visits"
import { CHECK_IN_SITE_STORAGE_KEY, readPersisted } from "@/lib/storage-keys"
import { cn } from "@/lib/utils"

/** How long the address search waits after the last key before it asks. */
const SEARCH_DELAY_MS = 300

/** The site the device remembers, by project: read defensively, since a browser may hold anything there. */
function rememberedPick(): { projectId: string; siteId: string } | null {
  if (typeof window === "undefined") return null
  try {
    const raw = readPersisted(window.localStorage, CHECK_IN_SITE_STORAGE_KEY)
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { projectId?: unknown }).projectId === "string" && typeof (parsed as { siteId?: unknown }).siteId === "string") return parsed as { projectId: string; siteId: string }
  } catch {
    // A value this page did not write: forget it.
  }
  return null
}

function remember(pick: { projectId: string; siteId: string }) {
  try {
    window.localStorage.setItem(CHECK_IN_SITE_STORAGE_KEY, JSON.stringify(pick))
  } catch {
    // A store that refuses writes: the site is picked again next time.
  }
}

/** The sites read for a project, or why they could not be. */
type SitesRead = { status: "reading" } | { status: "read"; projectId: string; sites: VisitSite[] } | { status: "refused"; sentence: string }

export function CheckInApp() {
  const { apiConfigured, session, me, signOut } = useApiSession()
  const signedIn = apiConfigured && session !== null

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-4">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Recycle className="size-6 text-primary" weight="duotone" aria-hidden />
            <div>
              <p className="text-base font-semibold leading-tight">Check-in</p>
              {me !== null && <p className="text-sm text-muted-foreground">{me.user.fullName}</p>}
            </div>
          </div>
          {signedIn && (
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <SignOut aria-hidden />
              Sign out
            </Button>
          )}
        </header>
        {!signedIn ? (
          <section className="flex flex-col gap-3 rounded-xl border p-4">
            <h1 className="text-lg font-semibold">Sign in to check visitors in</h1>
            <p className="text-sm text-muted-foreground">{apiConfigured ? "The check-in records each visit to a recycling centre once you sign in." : "The check-in works against the Waste API, and this deployment is not connected to one."}</p>
            {apiConfigured && (
              <Button asChild className="h-11">
                <Link href={`${SIGN_IN_PATH}?next=${encodeURIComponent(CHECK_IN_PATH)}`}>Sign in</Link>
              </Button>
            )}
          </section>
        ) : me === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Reading your account…</p>
        ) : !allows(me.role.grants, "operate.site-visits", "create") ? (
          <section className="rounded-xl border border-destructive/40 p-4">
            <h1 className="font-semibold">This login does not check visitors in</h1>
            <p className="text-sm text-muted-foreground">{me.role.name} may not record site visits. The office gives the Site attendant role to the recycling centre&apos;s staff.</p>
          </section>
        ) : me.projects.length === 0 ? (
          <p className="rounded-xl border p-4 text-sm text-muted-foreground">You work in no project, so there is no recycling centre to check visitors in at.</p>
        ) : (
          <CheckInForm projects={me.projects} />
        )}
      </div>
    </div>
  )
}

function CheckInForm({ projects }: { projects: readonly { id: string; name: string }[] }) {
  const client = useApiClient()
  const [pick, setPick] = useState(() => {
    const saved = rememberedPick()
    const projectId = saved !== null && projects.some((project) => project.id === saved.projectId) ? saved.projectId : projects[0].id
    return { projectId, siteId: saved?.projectId === projectId ? saved.siteId : "" }
  })
  const [sites, setSites] = useState<SitesRead>({ status: "reading" })
  const [mode, setMode] = useState<CheckInMode>("plate")
  const [value, setValue] = useState("")
  const [query, setQuery] = useState("")
  const [found, setFound] = useState<{ query: string; items: VisitAddress[] } | { query: string; sentence: string } | null>(null)
  const [property, setProperty] = useState<VisitAddress | null>(null)
  const [fractions, setFractions] = useState<string[]>([])
  const [note, setNote] = useState("")
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [answer, setAnswer] = useState<SiteVisitCheckInAnswer | null>(null)
  const identifierRef = useRef<HTMLInputElement>(null)

  // The project's sites, read again whenever the project moves; the remembered one kept while the project still offers it.
  useEffect(() => {
    if (client === null) return
    let live = true
    readVisitSites(client, pick.projectId).then(
      (items) => {
        if (!live) return
        setSites({ status: "read", projectId: pick.projectId, sites: items })
        setPick((current) => (current.projectId === pick.projectId ? { ...current, siteId: rememberedSite(items, current.siteId === "" ? null : current.siteId) } : current))
      },
      (error: unknown) => {
        if (live) setSites({ status: "refused", sentence: problemSentence(problemOfError(error)) })
      },
    )
    return () => {
      live = false
    }
  }, [client, pick.projectId])

  // The address search, once the person has stopped typing; a later query wins over a read still on its way.
  useEffect(() => {
    const q = query.trim()
    if (client === null || mode !== "address" || q.length < ADDRESS_QUERY_MIN) return
    let live = true
    const timer = window.setTimeout(() => {
      searchVisitAddresses(client, pick.projectId, q).then(
        (items) => {
          if (live) setFound({ query: q, items })
        },
        (error: unknown) => {
          if (live) setFound({ query: q, sentence: problemSentence(problemOfError(error)) })
        },
      )
    }, SEARCH_DELAY_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [client, mode, pick.projectId, query])

  const shownSites = sites.status === "read" && sites.projectId === pick.projectId ? sites.sites : []
  const site = shownSites.find((candidate) => candidate.id === pick.siteId)

  const pickSite = (siteId: string) => {
    const next = { ...pick, siteId }
    setPick(next)
    setFractions([])
    remember(next)
  }
  const pickProject = (projectId: string) => {
    setPick({ projectId, siteId: "" })
    setSites({ status: "reading" })
    setProperty(null)
    setFound(null)
    setFractions([])
  }
  const pickMode = (next: CheckInMode) => {
    setMode(next)
    setRefusal(null)
    setProperty(null)
  }
  const nextVisitor = () => {
    setAnswer(null)
    setValue("")
    setQuery("")
    setFound(null)
    setProperty(null)
    setFractions([])
    setNote("")
    setRefusal(null)
    window.setTimeout(() => identifierRef.current?.focus(), 0)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (client === null || saving) return
    const body = checkInBodyOf({ siteId: pick.siteId, mode, value, propertyId: property?.propertyId ?? "", wasteFractionIds: fractions, note })
    if (typeof body === "string") {
      setRefusal(body)
      return
    }
    setSaving(true)
    setRefusal(null)
    checkInVisit(client, body)
      .then(setAnswer, (error: unknown) => setRefusal(problemSentence(problemOfError(error))))
      .finally(() => setSaving(false))
  }

  if (answer !== null) return <AnswerCard answer={answer} identifier={mode === "address" ? (property === null ? "" : `${property.name} · ${property.address}`) : answer.visit.identifierValue ?? ""} siteName={site?.name ?? ""} onNext={nextVisitor} />

  const shownFound = found !== null && found.query === query.trim() ? found : null

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {projects.length > 1 && (
        <div className="space-y-1.5">
          <Label htmlFor="check-in-project">Project</Label>
          <select id="check-in-project" className="h-11 w-full rounded-md border bg-background px-3 text-base" value={pick.projectId} onChange={(event) => pickProject(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="check-in-site">Recycling centre</Label>
        <select id="check-in-site" className="h-11 w-full rounded-md border bg-background px-3 text-base" value={pick.siteId} disabled={shownSites.length === 0} onChange={(event) => pickSite(event.target.value)}>
          <option value="">Pick the centre you are at</option>
          {shownSites.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
        {sites.status === "reading" && <p className="text-sm text-muted-foreground">Reading the recycling centres…</p>}
        {sites.status === "refused" && <p className="text-sm text-destructive">{sites.sentence}</p>}
        {sites.status === "read" && shownSites.length === 0 && <p className="text-sm text-muted-foreground">The project has no active recycling centre.</p>}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Identify the visitor by</legend>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Identify the visitor by">
          {CHECK_IN_MODES.map((option) => (
            <Button key={option.value} type="button" role="radio" aria-checked={mode === option.value} variant={mode === option.value ? "default" : "outline"} className="h-11" onClick={() => pickMode(option.value)}>
              {option.label}
            </Button>
          ))}
        </div>
        {mode === "address" ? (
          <div className="space-y-2">
            <div className="relative">
              <MagnifyingGlass className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                ref={identifierRef}
                aria-label="Address"
                className="h-11 pl-9 text-base"
                placeholder="Street, number or the property's name"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setProperty(null)
                }}
              />
            </div>
            {property !== null ? (
              <p className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
                <span className="font-medium">{property.name}</span> · {property.address}
              </p>
            ) : shownFound === null ? (
              query.trim().length > 0 && query.trim().length < ADDRESS_QUERY_MIN && <p className="text-sm text-muted-foreground">Type {ADDRESS_QUERY_MIN} letters at least.</p>
            ) : "sentence" in shownFound ? (
              <p className="text-sm text-destructive">{shownFound.sentence}</p>
            ) : shownFound.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No property of the project matches.</p>
            ) : (
              <ul className="flex flex-col gap-1" aria-label="Addresses found">
                {shownFound.items.map((item) => (
                  <li key={item.propertyId}>
                    <Button type="button" variant="outline" className="h-auto w-full justify-start py-2 text-left" onClick={() => setProperty(item)}>
                      <span>
                        <span className="block font-medium">{item.name}</span>
                        <span className="block text-sm text-muted-foreground">{item.address}</span>
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <Input
            ref={identifierRef}
            aria-label={mode === "plate" ? "Plate" : "Card number"}
            className="h-11 text-base uppercase tracking-wider"
            autoCapitalize="characters"
            autoComplete="off"
            placeholder={mode === "plate" ? "AB 12 345" : "Card number"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </fieldset>

      {site !== undefined && site.wasteFractions.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Brought</legend>
          <div className="flex flex-wrap gap-2">
            {site.wasteFractions.map((fraction) => {
              const on = fractions.includes(fraction.id)
              return (
                <Button key={fraction.id} type="button" aria-pressed={on} variant={on ? "default" : "outline"} className="h-10 rounded-full" onClick={() => setFractions(toggled(fractions, fraction.id))}>
                  {fraction.name}
                </Button>
              )
            })}
          </div>
        </fieldset>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="check-in-note">Note</Label>
        <Textarea id="check-in-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </div>

      {refusal !== null && (
        <p role="alert" className="text-sm text-destructive">
          {refusal}
        </p>
      )}
      <Button type="submit" className="h-12 text-base" disabled={saving || client === null}>
        {saving ? "Checking in…" : "Check in"}
      </Button>
    </form>
  )
}

function AnswerCard({ answer, identifier, siteName, onNext }: { answer: SiteVisitCheckInAnswer; identifier: string; siteName: string; onNext: () => void }) {
  const headline = answerHeadline(answer)
  const admitted = headline.tone === "admitted"
  return (
    <section aria-label="Check-in answer" className={cn("flex flex-col gap-3 rounded-xl border-2 p-5", admitted ? "border-primary bg-primary/5" : "border-destructive bg-destructive/5")}>
      <div className="flex items-center gap-2">
        {admitted ? <CheckCircle className="size-8 text-primary" weight="fill" aria-hidden /> : <XCircle className="size-8 text-destructive" weight="fill" aria-hidden />}
        <h1 className="text-xl font-semibold">{headline.title}</h1>
      </div>
      {identifier !== "" && <p className="text-lg font-medium tracking-wide">{identifier}</p>}
      {headline.detail !== null && <p className="text-sm">{headline.detail}</p>}
      {answer.charge !== null && <p className="text-lg">{chargeSentence(answer.charge, BLOCK_REASON_LABELS)}</p>}
      {siteName !== "" && <p className="text-sm text-muted-foreground">{siteName}</p>}
      <Button className="mt-2 h-12 text-base" onClick={onNext} autoFocus>
        Next visitor
      </Button>
    </section>
  )
}
