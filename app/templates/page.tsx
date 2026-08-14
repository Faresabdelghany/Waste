import { redirect } from "next/navigation"

export default function TemplatesPage() {
  redirect("/settings?pane=ticket-comms")
}
