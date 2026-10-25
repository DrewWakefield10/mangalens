"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Upload,
  Link2,
  Languages,
  ScanText,
  Paintbrush,
  ShieldCheck,
  Check,
  BookOpen,
  MoveHorizontal,
} from "lucide-react";
export default function Home() {
  const [url, setUrl] = useState("");
  const router = useRouter();
  const [split, setSplit] = useState(50);
  return (
    <main>
      <section className="hero">
        <div className="eyebrow">
          <span className="live-dot" /> YOUR NEXT CHAPTER, WITHOUT LIMITS
        </div>
        <h1>
          Every Story.
          <br />
          <span>Every Language.</span>
        </h1>
        <p className="hero-copy">
          Translate manga, manhwa, and webtoons into your language
          <br className="desktop" /> while preserving the artwork you love.
        </p>
        <form
          className="import-bar"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(
              "/translate" + (url ? "?url=" + encodeURIComponent(url) : ""),
            );
          }}
        >
          <Link2 size={21} />
          <input
            aria-label="Manga chapter URL"
            placeholder="Paste a supported manga chapter URL..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="button primary" type="submit">
            Translate Manga <ArrowRight size={17} />
          </button>
        </form>
        <div className="upload-line">
          <span>or start with your own pages</span>
          <Link href="/translate" className="upload-link">
            <Upload size={16} /> Upload Images
          </Link>
        </div>
        <div className="tiny-note">
          JPG, PNG, WebP, ZIP, CBZ & PDF <span>·</span> Private by default{" "}
          <ShieldCheck size={13} />
        </div>
        <div className="language-row">
          <span>STORIES SPEAK EVERY LANGUAGE</span>
          <b>日本語</b>
          <b>한국어</b>
          <b>中文</b>
          <b>English</b>
          <b>Русский</b>
          <span>+ more with a provider</span>
        </div>
      </section>
      <section className="demo-section">
        <div className="section-intro">
          <div>
            <div className="eyebrow">LOST IN TRANSLATION? NOT THE ART.</div>
            <h2>
              A new language.
              <br />
              The same world.
            </h2>
          </div>
          <p>
            Original linework. Every expression. Every detail.
            <br />
            Only the words need to change.
          </p>
        </div>
        <div className="comparison-demo">
          <div className="demo-art">
            <img
              src="/demo-original.svg"
              alt="Original MangaLens sample comic with Japanese dialogue"
            />
            <div
              className="demo-after"
              style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
            >
              <img
                src="/demo-translated.svg"
                alt="Human-authored English lettering example"
              />
            </div>
            <span className="image-tag left">ENGLISH</span>
            <span className="image-tag right">JAPANESE · ORIGINAL</span>
            <div className="split-line" style={{ left: split + "%" }}>
              <span>
                <MoveHorizontal size={20} />
              </span>
            </div>
            <input
              className="comparison-range"
              type="range"
              min="0"
              max="100"
              value={split}
              onChange={(e) => setSplit(+e.target.value)}
              aria-label="Compare original and translated sample"
            />
          </div>
          <div className="demo-caption">
            <span>
              <MoveHorizontal size={15} /> Drag to explore the difference
            </span>
            <span>
              Original sample artwork · Lettering illustration, not an AI result
            </span>
          </div>
        </div>
      </section>
      <section className="features">
        <div className="section-intro">
          <div>
            <div className="eyebrow">FROM PAGE TO POSSIBILITY</div>
            <h2>Less friction. More story.</h2>
          </div>
          <Link href="/translate" className="text-link">
            Start a translation <ArrowUpRight size={18} />
          </Link>
        </div>
        <div className="feature-grid">
          {[
            {
              icon: ScanText,
              n: "01",
              title: "Find the words",
              text: "Language-aware OCR locates and reads the text. Uncertain recognition is flagged for your review.",
            },
            {
              icon: Languages,
              n: "02",
              title: "Carry the meaning",
              text: "Choose offline translation or connect your preferred provider. Refine names and dialogue in the editor.",
            },
            {
              icon: Paintbrush,
              n: "03",
              title: "Keep the feeling",
              text: "Targeted text masks preserve the original page. Compare every result and adjust the lettering.",
            },
          ].map((f) => (
            <article key={f.n}>
              <div className="feature-top">
                <f.icon size={25} />
                <span>{f.n}</span>
              </div>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="bottom-cta">
        <div>
          <BookOpen size={28} />
          <h2>The next story is waiting.</h2>
          <p>
            Bring a chapter you have permission to translate. Make it yours to
            read.
          </p>
        </div>
        <Link href="/translate" className="button primary">
          Open a new chapter <ArrowRight size={17} />
        </Link>
      </section>
      <div className="trust-line">
        <span>
          <ShieldCheck size={16} /> Your pages stay private
        </span>
        <span>
          <Check size={16} /> Original artwork retained
        </span>
        <span>
          <Languages size={16} /> Honest, editable translations
        </span>
      </div>
    </main>
  );
}
