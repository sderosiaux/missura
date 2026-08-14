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
    "AI agent security at the API level, not the identity level. Unlike MCP gateways and non-human identity platforms, Missura enforces what each agent can read — object by object, across Zendesk, Linear, Notion, and GitHub. Same SDK, short-lived mission tokens.",
  openGraph: {
    title: "Missura — Same API. Smaller permissions. For every agent.",
    description:
      "Keep the vendor SDK; scope every agent run to one customer, for 30 minutes, with zero vendor credentials in its hands.",
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
