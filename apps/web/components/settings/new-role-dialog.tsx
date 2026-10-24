"use client"

// New role on the Pilot (#291): the dialog writes a custom role through the
// record store to `POST /roles`, in the shape `RoleCreate` takes — the name,
// the scope and the description, and the matrix it starts from: none, or the
// one of a role the store loaded, a system role's among them, which is the
// way to change what a system role allows. A refusal (the 409 for a name the
// company already uses, a 400 naming the field) is shown in the API's own
// sentence and the dialog stays open; once the API has the role, its
// permissions open to be set.
import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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
import { Textarea } from "@/components/ui/textarea"
import { genericProblem, problemSentence } from "@/lib/api/problem"
import type { WriteOutcome } from "@/lib/api/records/server-records"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { mintRoleId, newRoleRecord } from "@/lib/data/users-roles"

/** The Start from option that copies nothing. */
const NO_PERMISSIONS = "none"

export function NewRoleDialog({
  open,
  onOpenChange,
  scopes,
  roles,
  companyRecordId,
  create,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scopes: readonly string[]
  /** The access module's role records, the ones a new role may start from. */
  roles: readonly BusinessRecord[]
  companyRecordId?: string
  /** The store's write: the outcome once the API has answered, or undefined when the record went to the browser instead. */
  create: (record: BusinessRecord) => Promise<WriteOutcome> | undefined
  /** The new role's web id, once the API has it: its permissions open next. */
  onCreated: (roleId: string) => void
}) {
  const [name, setName] = useState("")
  const [scope, setScope] = useState("")
  const [description, setDescription] = useState("")
  const [startFrom, setStartFrom] = useState(NO_PERMISSIONS)
  const [submitting, setSubmitting] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const reset = () => {
    setName("")
    setScope("")
    setDescription("")
    setStartFrom(NO_PERMISSIONS)
    setRefusal(null)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting) return
    onOpenChange(nextOpen)
    if (!nextOpen) reset()
  }

  // A promise chain rather than try/finally, which the React Compiler skips.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim() || !scope || !description.trim()) {
      setRefusal("Complete the role name, the scope and the description.")
      return
    }
    setRefusal(null)
    setSubmitting(true)
    const source = roles.find((candidate) => candidate.id === startFrom)
    const record = newRoleRecord({ name, scope, description, startFrom: source }, mintRoleId(), companyRecordId)
    // No outcome means the record went to the browser, which on the Pilot is no role at all: said so, never a success.
    const outcome: Promise<WriteOutcome> =
      create(record) ??
      Promise.resolve({ kind: "refused", recordId: record.id, problem: genericProblem(400, "The company's roles are not being read from the API right now, so no role was written.") })
    void outcome
      .then((result) => {
        if (result.kind === "refused") {
          setRefusal(problemSentence(result.problem))
          return
        }
        onOpenChange(false)
        reset()
        toast.success("Role created", { description: `Set what ${record.name} allows; it can be given when adding users.` })
        onCreated(record.id)
      })
      .finally(() => setSubmitting(false))
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New role</DialogTitle>
            <DialogDescription>
              A custom role of your company: its permissions are set next, and
              it can be given to users once it is saved.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-5">
            <div className="space-y-2">
              <Label htmlFor="new-role-name">Role name</Label>
              <Input id="new-role-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Depot Supervisor" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-role-scope">Scope</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger id="new-role-scope">
                  <SelectValue placeholder="Select scope" />
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {candidate}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Where the role applies when it is given to a user.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-role-description">Description</Label>
              <Textarea
                id="new-role-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Warehouses, containers, and spare parts"
                rows={3}
                required
              />
              <p className="text-xs text-muted-foreground">Shown in the roles table to say what the role is for.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-role-start-from">Start from</Label>
              <Select value={startFrom} onValueChange={setStartFrom}>
                <SelectTrigger id="new-role-start-from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PERMISSIONS}>No permissions</SelectItem>
                  {roles.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The permissions the new role begins with. A system role&apos;s
                cannot be changed, so start from one to make a role that allows
                more or less.
              </p>
            </div>
            {refusal !== null && (
              <p role="alert" className="text-sm text-destructive">
                {refusal}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
