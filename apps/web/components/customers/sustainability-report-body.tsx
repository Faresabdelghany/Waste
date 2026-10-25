// The body of a Customer's sustainability report (M13 of #293), shared by
// the customer's details and the printable page: the headline figures, the
// warnings to read first, and a table per site of its fractions — how each
// was weighed, its treatment and its CO₂e. The words are
// lib/insight/sustainability.ts'.
import type { SustainabilityReport } from "@waste/contracts/sustainability"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { weightOf } from "@/lib/insight/dashboard"
import { basisOf, co2eOf, notAttributedOf, stopsText, totalsOf, treatmentOf, warningsOf, weighedKg } from "@/lib/insight/sustainability"

export function SustainabilityReportBody({ report }: { report: SustainabilityReport }) {
  const totals = totalsOf(report)
  const warnings = warningsOf(report)
  return (
    <div className="space-y-4" data-testid="sustainability-report">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Figure label="Weighed" value={totals.weighed} testId="sustainability-weighed" />
        <Figure label="Recycling rate" value={totals.rate} testId="sustainability-rate" />
        <Figure label="Footprint" value={totals.footprint} testId="sustainability-footprint" />
        <Figure label="Avoided" value={totals.avoided} testId="sustainability-avoided" />
      </dl>
      {totals.unmeasured !== null && <p className="text-xs text-muted-foreground">{totals.unmeasured}</p>}
      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200 print:border-black print:bg-white print:text-black" data-testid="sustainability-warnings">
          {warnings.map((warning) => (
            <li key={warning.key}>{warning.sentence}</li>
          ))}
        </ul>
      )}
      {report.sites.map((site) => (
        <section key={site.propertyId ?? site.sharedCollectionPointId} className="space-y-1.5" aria-label={site.name}>
          <h4 className="text-sm font-semibold">
            {site.name} <span className="font-normal text-muted-foreground">· {site.address}</span>
          </h4>
          {site.lines.length > 0 && (
            <div className="overflow-x-auto">
              <Table className="min-w-[560px] text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Fraction</TableHead>
                    <TableHead>Treatment</TableHead>
                    <TableHead className="text-right">Weighed</TableHead>
                    <TableHead>How</TableHead>
                    <TableHead className="text-right">Stops</TableHead>
                    <TableHead className="text-right">Footprint</TableHead>
                    <TableHead className="text-right">Avoided</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {site.lines.map((line) => (
                    <TableRow key={line.wasteFractionId}>
                      <TableCell className="font-medium">{line.name}</TableCell>
                      <TableCell>{treatmentOf(line)}</TableCell>
                      <TableCell className="text-right tabular-nums">{weightOf(weighedKg(line))}</TableCell>
                      <TableCell className="text-muted-foreground">{basisOf(line)}</TableCell>
                      <TableCell className="text-right tabular-nums">{stopsText(line)}</TableCell>
                      <TableCell className="text-right tabular-nums">{co2eOf(line.footprintGrams)}</TableCell>
                      <TableCell className="text-right tabular-nums">{co2eOf(line.avoidedGrams)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {notAttributedOf(site) !== null && <p className="text-xs text-muted-foreground">{notAttributedOf(site)}</p>}
        </section>
      ))}
    </div>
  )
}

function Figure({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2 print:border-black">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  )
}
