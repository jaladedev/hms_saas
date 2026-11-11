import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HMS",
  description: "Hotel management system",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@500;700&family=Sora:wght@500;700&family=Lora:wght@500;700&family=Outfit:wght@500;700&family=Source+Serif+4:wght@400;600&display=swap"
        />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
