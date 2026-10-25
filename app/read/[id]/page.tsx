"use client";
import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minus,
  Plus,
  Pencil,
  Columns2,
  BookOpen,
} from "lucide-react";
import { useProject } from "@/components/project-hooks";
import { api, Page, ready } from "@/lib/api";
import { usePreferences } from "@/lib/store";
function Compare({
  page,
  comparison,
  original,
}: {
  page: Page;
  comparison: string;
  original: boolean;
}) {
  const [split, setSplit] = useState(50);
  if (!ready(page) || original)
    return (
      <img
        className="reader-image"
        src={page.original}
        alt={"Original page " + (page.position + 1)}
        loading="lazy"
      />
    );
  if (comparison === "side")
    return (
      <div className="side-by-side">
        <img src={page.original} alt="Original page" />
        <img src={page.translated} alt="Translated page" />
      </div>
    );
  if (comparison === "slider")
    return (
      <div className="reader-compare">
        <img src={page.original} alt="Original page" />
        <img
          className="overlay-image"
          src={page.translated}
          alt="Translated page"
          style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
        />
        <div className="split-line" style={{ left: split + "%" }} />
        <input
          className="comparison-range"
          aria-label="Compare page versions"
          type="range"
          value={split}
          onChange={(e) => setSplit(+e.target.value)}
        />
      </div>
    );
  return (
    <img
      className="reader-image"
      src={page.translated}
      alt={"Translated page " + (page.position + 1)}
      loading="lazy"
    />
  );
}
export default function Reader({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: p, error } = useProject(id);
  const pref = usePreferences();
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [original, setOriginal] = useState(false);
  const [comparison, setComparison] = useState("toggle");
  const [zoom, setZoom] = useState(100);
  const [fit, setFit] = useState("width");
  const shell = useRef<HTMLDivElement>(null);
  const touch = useRef(0);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (p && !loaded) {
      const supplied = new URLSearchParams(location.search).get("page");
      setIndex(
        Math.min(
          p.pages.length - 1,
          Math.max(0, supplied === null ? p.last_page : Number(supplied) || 0),
        ),
      );
      setLoaded(true);
    }
  }, [p, loaded]);
  useEffect(() => {
    if (!p || !loaded) return;
    const timer = setTimeout(() => {
      api("/projects/" + id + "/progress", {
        method: "PUT",
        body: JSON.stringify({ page: index }),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [id, index, p?.id, loaded]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.target as HTMLElement).matches("input,select,textarea")) return;
      if (e.key === "o") setOriginal((x) => !x);
      if (e.key === "ArrowRight")
        setIndex((i) =>
          Math.max(
            0,
            Math.min(
              (p?.pages.length || 1) - 1,
              i + (pref.direction === "rtl" ? -1 : 1),
            ),
          ),
        );
      if (e.key === "ArrowLeft")
        setIndex((i) =>
          Math.max(
            0,
            Math.min(
              (p?.pages.length || 1) - 1,
              i + (pref.direction === "rtl" ? 1 : -1),
            ),
          ),
        );
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [p?.pages.length, pref.direction]);
  useEffect(() => {
    if (!p) return;
    for (const page of p.pages.slice(index + 1, index + 3)) {
      const img = new Image();
      img.src = ready(page) ? page.translated : page.original;
    }
  }, [p?.id, index, p?.ready]);
  useEffect(() => {
    if (pref.mode === "scroll" && loaded)
      document
        .getElementById("reader-page-" + index)
        ?.scrollIntoView({ block: "start" });
  }, [loaded, pref.mode]);
  if (!p)
    return (
      <main className="workspace">{error?.message || "Opening reader…"}</main>
    );
  const next = (delta: number) => {
    setIndex((i) => Math.max(0, Math.min(p.pages.length - 1, i + delta)));
  };
  const visible =
    pref.mode === "scroll"
      ? p.pages
      : pref.mode === "double"
        ? p.pages.slice(index, index + 2)
        : p.pages.slice(index, index + 1);
  return (
    <main ref={shell} className={"reader-shell fit-" + fit}>
      <div className="reader-toolbar">
        <Link
          className="icon-button"
          aria-label="Back to chapter"
          href={"/projects/" + id}
        >
          <ArrowLeft size={20} />
        </Link>
        <div className="reader-title">
          <b>{p.title}</b>
          <small>
            {p.ready} / {p.pages.length} translated
          </small>
        </div>
        <div className="segmented">
          <button
            className={!original ? "selected" : ""}
            onClick={() => setOriginal(false)}
          >
            Translated
          </button>
          <button
            className={original ? "selected" : ""}
            onClick={() => setOriginal(true)}
          >
            Original
          </button>
        </div>
        <select
          aria-label="Reading mode"
          value={pref.mode}
          onChange={(e) =>
            pref.set({ mode: e.target.value as "single" | "double" | "scroll" })
          }
        >
          <option value="single">Single page</option>
          <option value="double">Double spread</option>
          <option value="scroll">Vertical scroll</option>
        </select>
        <select
          aria-label="Comparison mode"
          value={comparison}
          onChange={(e) => {
            setComparison(e.target.value);
            setOriginal(false);
          }}
        >
          <option value="toggle">Toggle view</option>
          <option value="slider">Comparison slider</option>
          <option value="side">Side by side</option>
        </select>
        <button
          className="icon-button"
          aria-label="Fullscreen"
          onClick={() => {
            const action = document.fullscreenElement
              ? document.exitFullscreen()
              : shell.current?.requestFullscreen();
            action?.catch(() =>
              setNotice("Fullscreen is unavailable in this browser."),
            );
          }}
        >
          <Maximize size={18} />
        </button>
        <Link
          className="icon-button"
          aria-label="Edit current page"
          href={"/editor/" + id + "?page=" + index}
        >
          <Pencil size={18} />
        </Link>
      </div>
      {notice && <div className="note">{notice}</div>}
      <div className="reader-subbar">
        <button
          onClick={() =>
            pref.set({ direction: pref.direction === "rtl" ? "ltr" : "rtl" })
          }
        >
          {pref.direction === "rtl" ? "← Right to left" : "Left to right →"}
        </button>
        <span>O to compare · Arrow keys to turn pages</span>
        <div className="zoom-controls">
          <button
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(40, z - 10))}
          >
            <Minus size={15} />
          </button>
          <span>{zoom}%</span>
          <button
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(200, z + 10))}
          >
            <Plus size={15} />
          </button>
          <select
            aria-label="Page fit"
            value={fit}
            onChange={(e) => {
              setFit(e.target.value);
              setZoom(100);
            }}
          >
            <option value="width">Fit width</option>
            <option value="height">Fit height</option>
          </select>
        </div>
      </div>
      <div
        className={"reader-canvas " + (pref.mode === "double" ? "spread" : "")}
        style={{
          maxWidth: ((pref.mode === "double" ? 1500 : 900) * zoom) / 100,
          flexDirection:
            pref.mode === "double" && pref.direction === "rtl"
              ? "row-reverse"
              : undefined,
        }}
        onTouchStart={(e) => {
          touch.current = e.changedTouches[0].clientX;
        }}
        onTouchEnd={(e) => {
          if (pref.mode === "scroll") return;
          const delta = e.changedTouches[0].clientX - touch.current;
          if (Math.abs(delta) > 70)
            next((delta < 0 ? 1 : -1) * (pref.direction === "rtl" ? -1 : 1));
        }}
      >
        {visible.map((page) => (
          <section
            id={"reader-page-" + page.position}
            key={page.id}
            className="reader-page"
            onMouseEnter={() => {
              if (pref.mode === "scroll") setIndex(page.position);
            }}
          >
            <Compare page={page} comparison={comparison} original={original} />
            <div className="page-caption">
              Page {page.position + 1}
              {!ready(page) && (
                <span>Original shown · {page.status.replaceAll("_", " ")}</span>
              )}
              {page.status === "needs_review" && (
                <Link href={"/editor/" + id + "?page=" + page.position}>
                  Needs review ↗
                </Link>
              )}
            </div>
          </section>
        ))}
      </div>
      <div className="reader-bottom">
        <button
          className="icon-button"
          aria-label="Previous page"
          disabled={index === 0}
          onClick={() => next(-1)}
        >
          <ChevronLeft size={20} />
        </button>
        <label>
          Page{" "}
          <select
            aria-label="Jump to page"
            value={index}
            onChange={(e) => {
              setIndex(+e.target.value);
              if (pref.mode === "scroll")
                document
                  .getElementById("reader-page-" + e.target.value)
                  ?.scrollIntoView();
            }}
          >
            {p.pages.map((page, i) => (
              <option key={page.id} value={i}>
                {i + 1}
              </option>
            ))}
          </select>{" "}
          of {p.pages.length}
        </label>
        <button
          className="icon-button"
          aria-label="Next page"
          disabled={index >= p.pages.length - 1}
          onClick={() => next(pref.mode === "double" ? 2 : 1)}
        >
          <ChevronRight size={20} />
        </button>
      </div>
    </main>
  );
}
