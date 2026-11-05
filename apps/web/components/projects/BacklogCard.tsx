import Link from "next/link"
import { Tag, UsersThree, UserCircle, SquaresFour } from "@phosphor-icons/react/dist/ssr"
import { CircleDashed, Cube, User, Users } from "@phosphor-icons/react/dist/ssr"

import type { BacklogSummary } from "@/lib/data/project-details"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { StatRow } from "@/components/projects/StatRow"
import { PriorityGlyphIcon, type PriorityLevel } from "@/components/priority-badge"
import { AvatarGroup } from "@/components/projects/AvatarGroup"

type BacklogCardProps = {
  backlog: BacklogSummary
}

function statusStyles(status: BacklogSummary["statusLabel"]) {
  if (status === "Active") return "bg-info/10 text-info-foreground border-none"
  if (status === "Backlog")
    return "bg-warning/10 text-warning-foreground border-warning/30"
  if (status === "Planned")
    return "border-border bg-muted text-muted-foreground"
  if (status === "Completed") return "bg-info/10 text-info-foreground border-none"
  if (status === "Cancelled") return "bg-destructive/10 text-destructive-foreground border-none"
  return "border-border bg-muted text-muted-foreground"
}

export function BacklogCard({ backlog }: BacklogCardProps) {
  return (
    <div>
      <div className="pb-6">
        <div className="text-base font-medium">Operations</div>
      </div>
      <div className="space-y-5">
        <StatRow
          label="Status"
          value={<Badge variant="outline" className={statusStyles(backlog.statusLabel)}>{backlog.statusLabel}</Badge>}
          icon={<CircleDashed className="h-4 w-4" />}
        />
        <StatRow label="Group" value={<span className="px-2">{backlog.groupLabel}</span>} icon={<Cube className="h-4 w-4" />} />
        <StatRow label="Priority" value={<span className="px-2">{backlog.priorityLabel}</span>} icon={<PriorityGlyphIcon level={backlog.priorityLabel.toLowerCase() as PriorityLevel} size="sm" />} />
        <StatRow label="Label" value={<Badge variant="secondary" className="border border-border">{backlog.labelBadge}</Badge>} icon={<Tag className="h-4 w-4" />} />
        <StatRow label="PIC" value={<div className="px-2"><AvatarGroup users={backlog.picUsers} /></div>} icon={<User className="h-4 w-4" />} />
        {backlog.supportUsers && backlog.supportUsers.length ? (
          <StatRow label="Support" value={<div className="px-2"><AvatarGroup users={backlog.supportUsers} /></div>} icon={<Users className="h-4 w-4" />} />
        ) : null}
      </div>
    </div>
  )
}
