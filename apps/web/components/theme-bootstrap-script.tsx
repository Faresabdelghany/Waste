import { THEME_BOOTSTRAP_SOURCE } from "@/lib/theme-bootstrap"

export function ThemeBootstrapScript() {
  return (
    <script
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SOURCE }}
    />
  )
}
