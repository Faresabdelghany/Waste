import type React from "react"
import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import { Toaster } from "@/components/ui/sonner"
import { ThemeProvider } from "@/components/theme-provider"
import { AppThemeProvider } from "@/components/app-theme-provider"
import { ThemeBootstrapScript } from "@/components/theme-bootstrap-script"
import { BusinessRecordStoreProvider } from "@/components/wastehero/business-record-store"
import { OrganizationStoreProvider } from "@/components/settings/organization-store"
import { AssetManagementStoreProvider } from "@/components/settings/asset-management-store"
import { CommercialRegistriesStoreProvider } from "@/components/settings/commercial-registries-store"
import "./globals.css"

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
})
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
})

export const metadata: Metadata = {
  title: "WasteHero Operations",
  description: "Plan, deliver, monitor, and improve waste and recycling services.",
  icons: {
    icon: "/icon.png",
    apple: "/apple-touch-icon.png",
  },
}

export const viewport: Viewport = {
  colorScheme: "light dark",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeBootstrapScript />
      </head>
      <body
        className={`${geist.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <AppThemeProvider>
            <OrganizationStoreProvider>
              <AssetManagementStoreProvider>
                <CommercialRegistriesStoreProvider>
                  <BusinessRecordStoreProvider>
                    {children}
                    <Analytics />
                    <Toaster richColors closeButton />
                  </BusinessRecordStoreProvider>
                </CommercialRegistriesStoreProvider>
              </AssetManagementStoreProvider>
            </OrganizationStoreProvider>
          </AppThemeProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
