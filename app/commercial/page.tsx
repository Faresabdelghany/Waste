import { WorkspacePageShell } from "@/components/wastehero/workspace-page-shell"
import { ProductsPricesPrototype } from "@/components/wastehero/products-prices-prototype"

// PROTOTYPE gate — in dev, plain /commercial (the sidebar link) and
// /commercial?variant=a both render the chosen Variant A of the Products &
// Prices redesign (components/wastehero/products-prices-prototype/, spec §10
// verdict). ?tag= preselects a price-list filter (deep link from the
// /settings → Commercial defaults price-lists index). The old workspace stays
// reachable via ?module=… (workspace-internal navigation) or ?variant=off.
// Production builds always get the unchanged workspace shell.
export default async function CommercialPage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string; tag?: string; module?: string }>
}) {
  const { variant, tag, module: moduleId } = await searchParams
  const showPrototype =
    process.env.NODE_ENV !== "production" &&
    (variant?.toLowerCase() === "a" || (variant === undefined && moduleId === undefined))
  if (showPrototype) {
    return <ProductsPricesPrototype initialTag={tag} />
  }
  return <WorkspacePageShell workspaceId="commercial" />
}
