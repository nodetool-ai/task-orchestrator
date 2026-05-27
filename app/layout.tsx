import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { auth } from "@/auth";
import { TopNav } from "@/components/pi/top-nav";
import { PiOverlays } from "@/components/pi/overlays";
import { LiveSidebar } from "@/components/pi/live-sidebar";
import { loadPaletteItems } from "@/lib/pi-floor-data";
import * as repo from "@/lib/repo";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Pi Factory",
  description: "Agent-first cockpit for autonomous coding agents.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const email = session?.user?.email ?? undefined;

  let paletteItems: ReturnType<typeof loadPaletteItems> = [];
  let personaIds: string[] = [];
  if (email) {
    try {
      paletteItems = loadPaletteItems();
      personaIds = repo.listPersonaIds();
    } catch {
      // DB may be uninitialized on first boot — palette/spawn will be empty.
    }
  }

  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} dark`} suppressHydrationWarning>
      <body
        className="min-h-screen font-sans antialiased"
        style={{ background: "var(--pi-bg)", color: "var(--pi-fg)" }}
      >
        <TopNav email={email} />
        <div style={{ display: "flex", alignItems: "stretch", minHeight: "calc(100vh - 48px)" }}>
          <LiveSidebar enabled={Boolean(email)} />
          <main style={{ flex: 1, minWidth: 0 }}>{children}</main>
        </div>
        <PiOverlays items={paletteItems} personaIds={personaIds} />
      </body>
    </html>
  );
}
