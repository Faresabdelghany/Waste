"use client"
// An organisation's Contact Persons in its details, on the Pilot (#291 C14):
// the people who speak for it, each with a role and the channels they are
// reached on, read from `GET /customers/:id/contacts`
// (records/customer-contacts.ts). Add contact and each contact's Edit open one
// dialog, sent as the customer's action; the list is read again once it
// lands. A contact who has left is made inactive in the same dialog, never
// deleted. A person customer is their own contact, so the section is an
// organisation's alone, and a role without `edit` reads the list and is
// offered no write.
import { useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApiSession } from "@/components/waste/api-session-store"
import { useBusinessRecordStore } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useModuleReady, useRowHistory } from "@/components/waste/commands/use-command-support"
import { allows } from "@/lib/api/grants"
import { CONTACT_ROLE_LABELS, contactLine, customerContacts, draftOf, NEW_CONTACT, saveContact, takesContacts, type ContactDraft } from "@/lib/api/records/customer-contacts"
import { customerKindOf } from "@/lib/api/records/registry"
import { CONTACTS_MODULE } from "@/lib/data/properties"

const ROLES = Object.entries(CONTACT_ROLE_LABELS) as Array<[ContactDraft["role"], string]>

/** An organisation's contact persons, and the dialog that adds or changes one. */
export function ContactPersonsSurface({ record }: RowSurfaceProps) {
  const { sendAction } = useBusinessRecordStore()
  const { me } = useApiSession()
  const moduleReady = useModuleReady(CONTACTS_MODULE)
  const writes = me !== null && allows(me.role.grants, "customers.contacts", "edit")
  const [version, setVersion] = useState(0)
  const contacts = useRowHistory(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId, record, version, customerContacts)
  const [draft, setDraft] = useState<ContactDraft | null>(null)
  const [busy, setBusy] = useState(false)

  if (!takesContacts(customerKindOf(record))) return null

  const save = () => {
    if (draft === null || busy) return
    setBusy(true)
    void saveContact(sendAction, record.id, draft).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      setDraft(null)
      setVersion((count) => count + 1)
      toast.success(draft.contactId === undefined ? "Contact person added" : "Contact person saved", { description: outcome.answer.name })
    })
  }
  const field = (key: "name" | "email" | "phone", label: string, type = "text") => (
    <div className="space-y-1.5">
      <Label htmlFor={`contact-${key}`}>{label}</Label>
      <Input id={`contact-${key}`} type={type} value={draft?.[key] ?? ""} onChange={(event) => draft !== null && setDraft({ ...draft, [key]: event.target.value })} />
    </div>
  )

  return (
    <section className="space-y-3" data-testid="contact-persons">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Contact persons</h3>
        {writes && (
          <Button variant="outline" size="sm" disabled={!moduleReady || contacts.rows === null || busy} onClick={() => setDraft({ ...NEW_CONTACT })}>
            Add contact
          </Button>
        )}
      </div>
      <ReadRows
        read={contacts}
        label="Reading the contact persons…"
        empty="No one is registered to speak for this organisation yet."
        testId="contact-person-rows"
        line={(contact) => (
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="font-medium">{contact.name}</span>
              <span className="block truncate text-muted-foreground">{contactLine(contact)}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {contact.status === "inactive" && (
                <Badge variant="outline" className="rounded-full">
                  Inactive
                </Badge>
              )}
              {writes && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(draftOf(contact))}>
                  Edit
                </Button>
              )}
            </span>
          </div>
        )}
      />
      {draft !== null && (
        <Dialog open onOpenChange={(open) => !open && setDraft(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{draft.contactId === undefined ? `New contact person for ${record.name}` : `Contact person of ${record.name}`}</DialogTitle>
              <DialogDescription>Someone who speaks for the organisation, reached on an e-mail or a phone or both. One who has left is made inactive, never deleted.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {field("name", "Name")}
              <div className="space-y-1.5">
                <Label htmlFor="contact-role">Role</Label>
                <Select value={draft.role} onValueChange={(role) => setDraft({ ...draft, role: role as ContactDraft["role"] })}>
                  <SelectTrigger id="contact-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {field("email", "E-mail", "email")}
              {field("phone", "Phone", "tel")}
              {draft.contactId !== undefined && (
                <div className="space-y-1.5">
                  <Label htmlFor="contact-status">Status</Label>
                  <Select value={draft.status} onValueChange={(status) => setDraft({ ...draft, status: status as ContactDraft["status"] })}>
                    <SelectTrigger id="contact-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive — has left</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={save}>
                {draft.contactId === undefined ? "Add contact" : "Save contact"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
