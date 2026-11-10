import type { ProofObjectLink } from "@waste/contracts/proof-objects"
import type { ProofOfService } from "@waste/contracts/proofs"

import { proofObjectNoun } from "@/lib/api/records/pickups"

/** A proof's photo or signature beside its line: the picture from its signed URL, opening it whole, or why there is none to show. */
export function ProofObject({ proof, links }: { proof: Pick<ProofOfService, "id" | "kind" | "objectKey">; links: { rows: ProofObjectLink[] | null; problem: string | null } }) {
  if (proof.objectKey === null || links.rows === null) return null
  const noun = proofObjectNoun(proof)
  const link = links.rows.find((candidate) => candidate.proofId === proof.id)
  if (link?.url == null) return <p className="mt-1 text-xs text-muted-foreground">The {noun} is no longer stored.</p>
  return (
    <a href={link.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-2 text-xs underline-offset-2 hover:underline">
      {/* A private object's signed URL, which next/image would fetch through the server. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={link.url} alt={`The ${noun} recorded at this stop`} className="h-16 w-16 rounded border bg-white object-contain" />
      Open {noun}
    </a>
  )
}
