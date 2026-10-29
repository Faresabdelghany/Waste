// Right-sizing's proposals (M23b of #293, row 26.5), the one writer of
// `right_sizing_proposal`: the worker runs it nightly per company
// (apps/worker/src/jobs/propose-right-sizing.ts), and the office on demand
// (`POST /right-sizing-proposals/run`), within its projects. Run as `wms_api`
// under the company's fence.
//
// Each subscription in force on its project's day, with no open proposal, is
// read with the latest `RIGHT_SIZING_WINDOW` fill estimates of the stops of
// the containers placed under it on their service dates, newest first, and
// judged by the domain's rule (`fillReadingOf`). Where the rule asks for a
// change, the product of the same project, kind, fraction and frequency a
// size down or up is suggested (`nextSize`) where the catalogue sells one,
// and fewer or more collections where it does not. A subscription is
// proposed again only on evidence newer than its last proposal's, so a
// dismissal holds until the drivers say something new. One open proposal per
// subscription is the table's own key; a run that meets one already made
// leaves it.
import { directionOf, fillReadingOf, nextSize, RIGHT_SIZING_WINDOW } from "@waste/domain/inspections/right-sizing"
import type { FillLevel } from "@waste/domain/execution/vocabulary"
import { sql, type SQL } from "drizzle-orm"

import type { Tx } from "../client"
import { rightSizingProposal } from "../schema/inspections"

/** One subscription with its latest estimates, as the run reads it. */
type Candidate = {
  subscription_id: string
  project_id: string
  product_id: string
  updated_at: string
  kind: string
  waste_fraction_id: string | null
  service_frequency_id: string | null
  volume_litres: number | null
  fills: FillLevel[]
  fill_ats: string[]
  last_evidence: string | null
}

/** An instant as ISO text, UTC to the microsecond, which `Date.parse` reads whatever the session's style. */
const iso = (column: SQL) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** The proposals a run made: how many, and their ids. */
export type RightSizingRunResult = { proposed: string[] }

/**
 * Proposes right-sizing for the company's subscriptions in force at `at` on
 * their projects' clocks, in `projectIds` where given (the office's
 * projects), every project otherwise.
 */
export async function proposeRightSizing(tx: Tx, companyId: string, at: Date, projectIds?: readonly string[]): Promise<RightSizingRunResult> {
  if (projectIds !== undefined && projectIds.length === 0) return { proposed: [] }
  const inProjects = projectIds === undefined ? sql`true` : sql`s.project_id in (${sql.join(
    projectIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`
  const candidates = await tx.execute<Candidate>(sql`
    select s.id as subscription_id, s.project_id, s.product_id, ${iso(sql`s.updated_at`)} as updated_at,
           pr.kind, pr.waste_fraction_id, pr.service_frequency_id, ct.volume_litres,
           f.fills, f.fill_ats,
           (select ${iso(sql`max(r.evidence_through)`)} from wms.right_sizing_proposal r where r.company_id = s.company_id and r.subscription_id = s.id) as last_evidence
      from wms.subscription s
      join wms.project p on p.company_id = s.company_id and p.id = s.project_id
      join wms.product pr on pr.company_id = s.company_id and pr.id = s.product_id
      left join wms.container_type ct on ct.company_id = pr.company_id and ct.id = pr.container_type_id
      cross join lateral (
        select array_agg(latest.fill_level order by latest.operating_date desc, latest.id desc) as fills,
               array_agg(${iso(sql`latest.at`)} order by latest.operating_date desc, latest.id desc) as fill_ats
          from (
            select pk.id, pk.fill_level, r.operating_date, coalesce(pk.outcome_at, pk.updated_at) as at
              from wms.pickup pk
              join wms.route r on r.company_id = pk.company_id and r.id = pk.route_id
              join wms.container_service_placement csp
                on csp.company_id = pk.company_id and csp.container_id = pk.container_id and csp.subscription_id = s.id
               and csp.valid_from <= r.service_date and (csp.valid_to is null or csp.valid_to > r.service_date)
             where pk.company_id = s.company_id and pk.fill_level is not null
             order by r.operating_date desc, pk.id desc
             limit ${RIGHT_SIZING_WINDOW}
          ) latest
      ) f
     where s.company_id = ${companyId}
       and ${inProjects}
       and s.valid_from <= (${at.toISOString()}::timestamptz at time zone p.timezone)::date
       and (s.valid_to is null or s.valid_to > (${at.toISOString()}::timestamptz at time zone p.timezone)::date)
       and f.fills is not null
       and not exists (select 1 from wms.right_sizing_proposal o where o.company_id = s.company_id and o.subscription_id = s.id and o.status = 'open')
     order by s.id
  `)
  const proposed: string[] = []
  for (const candidate of candidates) {
    const newest = candidate.fill_ats[0]
    // New evidence only: a subscription already proposed on these estimates waits for the next.
    if (candidate.last_evidence !== null && Date.parse(newest) <= Date.parse(candidate.last_evidence)) continue
    const reading = fillReadingOf(candidate.fills)
    if (reading.need === "none") continue
    const sized = candidate.volume_litres === null ? undefined : nextSize(candidate.volume_litres, await sizesBeside(tx, companyId, candidate), reading.need)
    const [made] = await tx
      .insert(rightSizingProposal)
      .values({
        companyId,
        projectId: candidate.project_id,
        subscriptionId: candidate.subscription_id,
        productId: candidate.product_id,
        direction: directionOf(reading.need, sized !== undefined),
        suggestedProductId: sized?.id ?? null,
        evidence: candidate.fills.slice(0, RIGHT_SIZING_WINDOW),
        evidenceThrough: new Date(newest),
        subscriptionUpdatedAt: new Date(candidate.updated_at),
      })
      .onConflictDoNothing()
      .returning({ id: rightSizingProposal.id })
    if (made !== undefined) proposed.push(made.id)
  }
  return { proposed }
}

/** The products sold beside the subscription's: the same project, kind, fraction and frequency, active, with a container of a known size. */
async function sizesBeside(tx: Tx, companyId: string, candidate: Candidate): Promise<{ id: string; volumeLitres: number }[]> {
  const rows = await tx.execute<{ id: string; volume_litres: number }>(sql`
    select pr.id, ct.volume_litres
      from wms.product pr
      join wms.container_type ct on ct.company_id = pr.company_id and ct.id = pr.container_type_id
     where pr.company_id = ${companyId} and pr.project_id = ${candidate.project_id} and pr.id <> ${candidate.product_id}
       and pr.status = 'active' and pr.kind = ${candidate.kind}
       and pr.waste_fraction_id is not distinct from ${candidate.waste_fraction_id}::uuid
       and pr.service_frequency_id is not distinct from ${candidate.service_frequency_id}::uuid
       and ct.volume_litres is not null
  `)
  return rows.map((row) => ({ id: row.id, volumeLitres: row.volume_litres }))
}
