export function getAvatarUrl(name?: string): string | undefined {
  if (!name) return undefined
  const key = name.trim().toLowerCase()

  // Sync with avatar config in SidebarFooter (app-sidebar.tsx).
  // In this demo, only the primary user uses a real photo; others fall back to initials.
  if (key === "jason duong" || key === "jason d" || key === "jd") {
    return "/avatar-profile.jpg"
  }

  return undefined
}
