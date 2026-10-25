import type { Metadata } from "next";
import Providers from "@/components/providers";
import Nav from "@/components/nav";
import "./globals.css";
export const metadata: Metadata = {
  title: "MangaLens — Read Beyond Language Barriers",
  description:
    "Translate manga while preserving the artwork you love. Private uploads, editable translations and an immersive reader.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <Nav />
          {children}
          <footer>
            <span className="brand">
              <span className="small-mark">ML</span> MangaLens
            </span>
            <span>Read beyond language barriers.</span>
            <a href="/about">Privacy & content permissions ↗</a>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
