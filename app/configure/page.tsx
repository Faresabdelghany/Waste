import { redirect } from "next/navigation"

export default function ConfigurePage() {
  redirect("/settings?pane=company")
}
