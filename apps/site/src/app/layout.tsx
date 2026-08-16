import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  ),
  title: "Missura — Same API. Smaller permissions. For every agent.",
  description:
    "Ship the customer-facing agent you shelved. Missura binds each agent run to one customer entity — read-only, minutes, no vendor credentials in the agent. An agent is not a user: nothing is copied, nothing indexed, and a mission mirrors nobody. Zendesk, Linear, GitHub, same SDK.",
  openGraph: {
    title: "Missura — Same API. Smaller permissions. For every agent.",
    description:
      "Keep the vendor SDK; bind every agent run to one customer, for 30 minutes, with zero vendor credentials in its hands.",
    type: "website",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
