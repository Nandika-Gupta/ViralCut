import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "ViralCut · Turn one video into viral shorts",
  description: "Paste a YouTube link or upload a video. ViralCut finds the best moments, adds captions and writes viral posts and hashtags for YouTube Shorts, Instagram Reels, Facebook and X.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { themeColor: "#060914", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Anton&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@500;600&family=Manrope:wght@400;500;600;700;800&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
