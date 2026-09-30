import type { ReactNode } from "react"

import { DriverAppProvider } from "@/components/waste/driver/driver-app-provider"

// The Driver App (Issue #145): one provider around the start screen and every
// route, so the Command Queue's controller outlives a move between them.
export default function DriverLayout({ children }: { children: ReactNode }) {
  return <DriverAppProvider>{children}</DriverAppProvider>
}
