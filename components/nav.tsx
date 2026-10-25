"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ArrowUpRight, Moon, Sun } from "lucide-react";
import { usePreferences } from "@/lib/store";
export default function Nav() {
  const path = usePathname();
  const pref = usePreferences();
  return (
    <header className="nav">
      <Link href="/" className="brand">
        <span className="brand-icon">
          <BookOpen size={22} />
        </span>
        Manga<span>Lens</span>
        <sup>BETA</sup>
      </Link>
      <nav aria-label="Main navigation">
        <Link
          className={path === "/translate" ? "active" : ""}
          href="/translate"
        >
          Translate
        </Link>
        <Link className={path === "/projects" ? "active" : ""} href="/projects">
          My library
        </Link>
        <Link href="/about">How it works</Link>
      </nav>
      <div className="nav-end">
        <button
          aria-label="Toggle theme"
          className="icon-button"
          onClick={() =>
            pref.set({ theme: pref.theme === "dark" ? "light" : "dark" })
          }
        >
          {pref.theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <Link className="button outline compact" href="/settings">
          Settings <ArrowUpRight size={15} />
        </Link>
      </div>
    </header>
  );
}
