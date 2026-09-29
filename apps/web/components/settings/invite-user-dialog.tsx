"use client"

// Add user on the Pilot (Issue #163): the dialog writes an Invitation through
// the record store to `POST /users`, in the shape `UserInvite` takes — the
// address, the full name, a role, and exactly one of every project, some
// projects or a service provider. There is no company picker, since the API
// invites into the caller's company, and the pickers list what the store
// loaded from the API (lib/data/users-roles.ts), so a role that exists only
// in the browser is never offered. A refusal — the 409 for an address the
// company already has, a 400 naming the field — is shown in the API's own
// sentence and the dialog stays open; nothing is sent to the person, and the
// account lists as invited until a Login with the address first signs in.
import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { problemSentence } from "@/lib/api/problem"
import type { WriteOutcome } from "@/lib/api/records/server-records"
import type { BusinessRecord } from "@/lib/data/business-modules"
import {
  inviteRecord,
  mintInviteId,
  type InviteAccess,
  type PickerOption,
} from "@/lib/data/users-roles"

type AccessKind = InviteAccess["kind"]

/** The role that always covers every project (CONTEXT.md: Company Administrator). */
const COMPANY_ADMINISTRATOR = "Company Administrator"

const ACCESS_LABELS: Record<AccessKind, string> = {
  "all-projects": "All current and future projects",
  projects: "Selected projects",
  "service-provider": "A service provider",
}

export function InviteUserDialog({
  open,
  onOpenChange,
  roles,
  projects,
  providers,
  companyRecordId,
  invite,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roles: readonly PickerOption[]
  projects: readonly PickerOption[]
  providers: readonly PickerOption[]
  companyRecordId?: string
  /** The store's write: the outcome once the API has answered, or undefined when the record went to the browser instead. */
  invite: (record: BusinessRecord) => Promise<WriteOutcome> | undefined
}) {
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [roleId, setRoleId] = useState("")
  const [accessKind, setAccessKind] = useState<AccessKind>("all-projects")
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [providerId, setProviderId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const role = roles.find((candidate) => candidate.id === roleId)
  const administrator = role?.name === COMPANY_ADMINISTRATOR
  const kind: AccessKind = administrator ? "all-projects" : accessKind

  const reset = () => {
    setFullName("")
    setEmail("")
    setRoleId("")
    setAccessKind("all-projects")
    setProjectIds([])
    setProviderId("")
    setRefusal(null)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting) return
    onOpenChange(nextOpen)
    if (!nextOpen) reset()
  }

  const chosenAccess = (): InviteAccess | null => {
    if (kind === "all-projects") return { kind }
    if (kind === "projects") {
      const chosen = projects.filter((project) => projectIds.includes(project.id))
      return chosen.length === 0 ? null : { kind, projects: chosen }
    }
    const provider = providers.find((candidate) => candidate.id === providerId)
    return provider === undefined ? null : { kind, provider }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const access = chosenAccess()
    if (!fullName.trim() || !email.trim() || role === undefined || access === null) {
      setRefusal("Complete the full name, the e-mail address, the role and the access.")
      return
    }
    setRefusal(null)
    setSubmitting(true)
    try {
      const record = inviteRecord({ fullName, email, role, access, companyRecordId }, mintInviteId())
      const outcome = await invite(record)
      if (outcome !== undefined && outcome.kind === "refused") {
        setRefusal(problemSentence(outcome.problem))
        return
      }
      onOpenChange(false)
      reset()
      toast.success("Invitation written", {
        description: `${record.name} lists as invited until a Login with this address first signs in.`,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              Writes an Invitation in your company. Nothing is sent: the
              account lists as invited until a Login with this address first
              signs in.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-5 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="invite-user-name">Full name</Label>
              <Input
                id="invite-user-name"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                autoComplete="name"
                required
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="invite-user-email">Email</Label>
              <Input
                id="invite-user-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
              <p className="text-xs text-muted-foreground">
                The address the Login is created with; it is what binds the
                two on first sign-in.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-user-role">Role</Label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger id="invite-user-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-user-access">Access</Label>
              <Select
                value={kind}
                onValueChange={(value) => setAccessKind(value as AccessKind)}
                disabled={administrator}
              >
                <SelectTrigger id="invite-user-access">
                  <SelectValue placeholder="Select access" />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ACCESS_LABELS) as AccessKind[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {ACCESS_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {administrator && (
                <p className="text-xs text-muted-foreground">
                  Company administrators always cover all projects.
                </p>
              )}
            </div>
            {kind === "projects" && (
              <fieldset className="space-y-2 sm:col-span-2">
                <legend className="text-sm font-medium">Projects</legend>
                {projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No project has been read from the API yet.
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {projects.map((project) => (
                      <label key={project.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={projectIds.includes(project.id)}
                          onCheckedChange={(checked) =>
                            setProjectIds((current) =>
                              checked
                                ? [...current, project.id]
                                : current.filter((id) => id !== project.id),
                            )
                          }
                        />
                        {project.name}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            )}
            {kind === "service-provider" && (
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="invite-user-service-provider">Service provider</Label>
                <Select value={providerId} onValueChange={setProviderId}>
                  <SelectTrigger id="invite-user-service-provider">
                    <SelectValue placeholder="Select service provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.length === 0 ? (
                      <SelectItem value="no-service-providers" disabled>
                        No service provider has been read from the API yet
                      </SelectItem>
                    ) : (
                      providers.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  A service provider&apos;s account reaches its provider and takes
                  no project access.
                </p>
              </div>
            )}
            {refusal && (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {refusal}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Writing…" : "Add user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
