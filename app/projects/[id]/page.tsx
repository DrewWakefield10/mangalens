"use client";
import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Pencil,
  RotateCcw,
  Trash2,
  Download,
  ArrowLeft,
  Pause,
  Play,
} from "lucide-react";
import { useProject } from "@/components/project-hooks";
import { api, languages, ready } from "@/lib/api";
import { Button } from "@/components/ui/button";
export default function Dashboard({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: p, error, refetch } = useProject(id);
  const [actionError, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [exportRights, setRights] = useState(false);
  const router = useRouter();
  async function action(path: string, method = "POST", body?: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      await refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!p)
    return (
      <main className="workspace">
        <p>{error?.message || "Opening your chapter…"}</p>
      </main>
    );
  return (
    <main className="workspace">
      <Link href="/projects" className="back-link">
        <ArrowLeft size={16} /> My library
      </Link>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {languages[p.source_lang]} → {languages[p.target_lang]}{" "}
            <span> / </span> {p.quality.toUpperCase()}
          </div>
          <h1>{p.title}</h1>
          <p className="lead">
            {p.pages.length} pages · {p.provider} · {p.style} translation
          </p>
        </div>
        <div className="actions">
          <Link className="button outline" href={"/editor/" + id}>
            <Pencil size={16} /> Edit translation
          </Link>
          <Link className="button primary" href={"/read/" + id}>
            <BookOpen size={17} /> Open reader
          </Link>
        </div>
      </div>
      <section className="panel progress-panel">
        <div>
          <span className="live-dot" />
          <h3>
            {p.active
              ? "Bringing your chapter to life"
              : p.pages.some((page) => page.status === "needs_review")
                ? "Pages are ready for review"
                : p.ready === p.pages.length
                  ? "Your chapter is ready"
                  : p.cancelled
                    ? "Processing paused"
                    : "Ready when you are"}
          </h3>
          <b>
            {p.ready}
            <span> / {p.pages.length} pages</span>
          </b>
        </div>
        <div className="progress-track">
          <span style={{ width: (p.ready / p.pages.length) * 100 + "%" }} />
        </div>
        <p>
          Start reading as soon as the first page is ready. Every original is
          preserved.{" "}
          {p.pages.filter((page) => page.status === "completed").length}{" "}
          completed ·{" "}
          {p.pages.filter((page) => page.status === "needs_review").length} need
          review.
        </p>
        <div className="actions">
          {p.active ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => action("/projects/" + id + "/cancel")}
            >
              <Pause size={15} /> Cancel pending pages
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                action("/projects/" + id + "/start", "POST", {
                  source_lang: p.source_lang,
                  target_lang: p.target_lang,
                  quality: p.quality,
                  style: p.style,
                  provider: p.provider,
                  direction: p.direction,
                })
              }
            >
              <Play size={15} />{" "}
              {p.ready ? "Reprocess chapter" : "Start / resume translation"}
            </Button>
          )}
          <a className="text-link" href={"/api/projects/" + id + "/metadata"}>
            Download project metadata
          </a>
        </div>
      </section>
      {(actionError || error) && (
        <div role="alert" className="error">
          {actionError || error?.message}
        </div>
      )}
      <div className="pages-list">
        {p.pages.map((page, i) => (
          <article key={page.id} className="panel page-row">
            <Link href={"/read/" + id + "?page=" + i}>
              <img src={page.thumbnail} alt={"Page " + (i + 1)} />
            </Link>
            <div>
              <small>PAGE {String(i + 1).padStart(2, "0")}</small>
              <h3>{page.name}</h3>
              <span className={"status " + page.status}>
                {page.status.replaceAll("_", " ")}
              </span>
              {p.active && page.status !== "queued" && page.status !== "imported" &&
                page.status !== "completed" && page.status !== "needs_review" &&
                page.status !== "failed" && (
                  <p className="hint">
                    {String(page.metrics.recognized_regions ?? 0)} recognized / {String(page.metrics.regions_detected ?? 0)} candidates
                    {page.metrics.translated_regions != null && ` · ${String(page.metrics.translated_regions)} translated`}
                    {Array.isArray(page.metrics.languages) && page.metrics.languages.length > 0 && ` · ${page.metrics.languages.join(", ")}`}
                    {page.metrics.elapsed_seconds != null && ` · ${String(page.metrics.elapsed_seconds)}s elapsed`}
                  </p>
                )}
              {page.error && <p className="error-text">{page.error}</p>}
              {typeof page.metrics.completion === "string" && (
                <p className="hint">
                  {page.metrics.completion === "PARTIALLY_COMPLETED" ? "Partially completed" : "Completed"}: {String(page.metrics.completed_regions ?? 0)} rendered / {String(page.metrics.regions ?? 0)} candidates · {String(page.metrics.unresolved_regions ?? 0)} unresolved
                  <br />
                  {String(page.metrics.confirmed_text_regions ?? 0)} confirmed · {String(page.metrics.probable_text_regions ?? 0)} probable · {String(page.metrics.uncertain_candidates ?? 0)} uncertain · {String(page.metrics.translation_success_regions ?? 0)} translated · {String(page.metrics.masked_regions ?? 0)} mask candidates · {String(page.metrics.cleaned_regions ?? 0)} cleaned
                </p>
              )}
              {page.status === "needs_review" && (
                <p className="hint">
                  Review flagged text or artwork in the editor.
                </p>
              )}
            </div>
            <div className="actions">
              {(ready(page) ||
                page.status === "failed" ||
                page.status === "imported") && (
                <Link
                  className="button ghost"
                  href={"/editor/" + id + "?page=" + i}
                >
                  Open Editor <Pencil size={15} />
                </Link>
              )}
              {!p.active && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    action("/pages/" + page.id + "/ocr", "POST", {})
                  }
                >
                  Retry OCR
                </Button>
              )}
              {!p.active && (
                <button
                  className="icon-button"
                  aria-label={"Retry page " + (i + 1)}
                  disabled={busy}
                  onClick={() => action("/pages/" + page.id + "/retry")}
                >
                  <RotateCcw size={17} />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <div className="export-row panel">
        <div>
          <h3>Take your chapter with you.</h3>
          <label className="check-field">
            <input
              type="checkbox"
              checked={exportRights}
              onChange={(e) => setRights(e.target.checked)}
            />{" "}
            I have permission to export this content.
          </label>
        </div>
        <div className="actions">
          {["cbz", "zip", "pdf"].map((format) => (
            <a
              key={format}
              aria-disabled={!exportRights || p.ready !== p.pages.length}
              className={
                "button outline " +
                (!exportRights || p.ready !== p.pages.length ? "disabled" : "")
              }
              href={
                exportRights && p.ready === p.pages.length
                  ? "/api/projects/" +
                    id +
                    "/export?authorized=true&format=" +
                    format
                  : undefined
              }
            >
              <Download size={15} />
              {format.toUpperCase()}
            </a>
          ))}
        </div>
      </div>
      <button
        className="text-link danger"
        disabled={p.active || busy}
        onClick={async () => {
          if (
            confirm("Delete this chapter, all images and edits permanently?")
          ) {
            setBusy(true);
            try {
              await api("/projects/" + id, { method: "DELETE" });
              router.push("/projects");
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }
        }}
      >
        <Trash2 size={15} /> Delete project
      </button>
    </main>
  );
}
