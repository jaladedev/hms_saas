import type { Metadata } from "next";
// The fonts are served from this app, not from Google: a slow or blocked fonts.googleapis.com used to hold up every page on a
// poor connection, and a saved page could not draw in its own fonts offline. Same families and weights as before.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/playfair-display/500.css";
import "@fontsource/playfair-display/700.css";
import "@fontsource/sora/500.css";
import "@fontsource/sora/700.css";
import "@fontsource/lora/500.css";
import "@fontsource/lora/700.css";
import "@fontsource/outfit/500.css";
import "@fontsource/outfit/700.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/600.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "HMS",
  description: "Hotel management system",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
