export type DemoAccount = {
  id: string
  name: string
  detail: string
  email: string
  initials: string
  avatarSrc?: string
  /** Route the account lands on after signing in. */
  homePath: string
  viewLabel: string
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    id: "olivia-larsen",
    name: "Olivia Larsen",
    detail: "Operations manager",
    email: "olivia.larsen@wastehero.io",
    initials: "OL",
    avatarSrc: "/avatar-profile.jpg",
    homePath: "/performance",
    viewLabel: "Operations workspace",
  },
  {
    id: "lars-mikkelsen",
    name: "Lars Mikkelsen",
    detail: "NordRen ApS · Manager",
    email: "lars.mikkelsen@nordren.dk",
    initials: "LM",
    homePath: "/contractor-workspace",
    viewLabel: "Contractor workspace",
  },
  {
    id: "osterbro-housing",
    name: "Østerbro Housing",
    detail: "Parkvej 18 · Authorized property user",
    email: "drift@oesterbro-housing.dk",
    initials: "ØH",
    homePath: "/portal",
    viewLabel: "Citizen portal",
  },
]
