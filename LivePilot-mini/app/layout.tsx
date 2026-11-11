import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_ORIGIN ?? "http://127.0.0.1:3000"),
  title: "Streamlabs Rounds",
  description: "Run Streamlabs chat rounds with multiple YouTube accounts.",
  openGraph: {
    title: "Streamlabs Rounds",
    description: "Run Streamlabs chat rounds with multiple YouTube accounts.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "LivePilot YouTube Live Chat Automation Dashboard" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Streamlabs Rounds",
    description: "Run isolated, observable YouTube live-chat automations from your own computer.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
