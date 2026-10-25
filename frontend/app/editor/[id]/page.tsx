"use client";
import { use, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  ArrowLeft,
  Save,
  Undo2,
  Redo2,
  RotateCcw,
  BookOpen,
} from "lucide-react";
import { useProject } from "@/components/project-hooks";
import { api, Region, ready, languages } from "@/lib/api";
import { Button } from "@/components/ui/button";
type Draft = {
  source_text: string;
  translation: string;
  language: string;
  font_size: number;
  align: string;
  offset_x: number;
  offset_y: number;
  restored: boolean;
  box: number[];
  source_box: number[];
  mask_include: number[][];
  mask_exclude: number[][];
  mask_dilation: number;
  source_verified: boolean;
};
function draftOf(r: Region): Draft {
  return {
    source_text: r.source_text,
    translation: r.translation,
    language: r.language,
    font_size: Number(r.render.font_size) || 42,
    align: String(r.render.align || "center"),
    offset_x: Number(r.render.offset_x) || 0,
    offset_y: Number(r.render.offset_y) || 0,
    restored: r.restored,
    box: r.box,
    source_box: (r.render.source_box as number[]) || r.box,
    mask_include: (r.render.mask_include as number[][]) || [],
    mask_exclude: (r.render.mask_exclude as number[][]) || [],
    mask_dilation: Number(r.render.mask_dilation ?? 1),
    source_verified: Boolean(r.render.source_verified),
  };
}
function diagnosticTone(r: Region) {
  const status = String(r.render.diagnostic_status || "");
  if (status === "COMPLETED") return "complete";
  if (status.includes("OCR_FAILED")) return "ocr-failed";
  if (status.includes("TRANSLATION_FAILED")) return "translation-failed";
  if (status.includes("MASK_FAILED")) return "cleanup-failed";
  if (status.includes("INPAINTING_FAILED")) return "cleanup-failed";
  if (status.includes("RENDERING_FAILED")) return "render-failed";
  return "review";
}
export default function Editor({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: p, error: loadError } = useProject(id);
  const client = useQueryClient();
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string>("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const dirty = useRef(false);
  const draftRegion = useRef("");
  const [undo, setUndo] = useState<Draft[]>([]);
  const [redo, setRedo] = useState<Draft[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState("translated");
  const [showRegions, setShowRegions] = useState(true);
  const [glossaryText, setGlossaryText] = useState("");
  const [drawMode, setDrawMode] = useState<
    "" | "add" | "source" | "include" | "exclude"
  >("");
  const [selection, setSelection] = useState<number[] | null>(null);
  const [drawStart, setDrawStart] = useState<number[] | null>(null);
  const [ocrLanguage, setOcrLanguage] = useState("ja");
  const page = p?.pages[index];
  useEffect(() => {
    setIndex(
      Math.max(
        0,
        Number(new URLSearchParams(location.search).get("page")) || 0,
      ),
    );
    api<{ source: string; target: string }[]>("/projects/" + id + "/glossary")
      .then((g) =>
        setGlossaryText(g.map((v) => v.source + " = " + v.target).join("\n")),
      )
      .catch(() => {});
  }, [id]);
  const { data: regions } = useQuery({
    queryKey: ["regions", page?.id, page?.revision],
    queryFn: () => api<Region[]>("/pages/" + page!.id + "/regions"),
    enabled: !!page,
    placeholderData: (previous, query) =>
      query?.queryKey[1] === page?.id ? previous : undefined,
  });
  const region = regions?.find((r) => r.id === selected);
  useEffect(() => {
    if (regions?.length && !regions.some((r) => r.id === selected))
      setSelected(regions[0].id);
  }, [regions, selected]);
  useEffect(() => {
    if (region) {
      if (dirty.current && draftRegion.current === region.id) return;
      draftRegion.current = region.id;
      dirty.current = false;
      setDraft(draftOf(region));
      setUndo([]);
      setRedo([]);
    }
  }, [region?.id, page?.id, region?.source_text]);
  async function recover(path: string, body?: unknown, queuedMessage = "OCR queued. Saved corrections are preserved; retry results appear as suggestions.") {
    setBusy(true);
    setError("");
    try {
      await api(path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      setNotice(queuedMessage);
      await client.invalidateQueries({ queryKey: ["project", id] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function point(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return [
      Math.round(
        Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) *
          page!.width,
      ),
      Math.round(
        Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) *
          page!.height,
      ),
    ];
  }
  async function finishDrawing() {
    setDrawStart(null);
    if (!selection || !page || selection[2] < 8 || selection[3] < 8) {
      setSelection(null);
      return;
    }
    if (drawMode === "add") {
      setBusy(true);
      setError("");
      try {
        const added = await api<Region>("/pages/" + page.id + "/regions", {
          method: "POST",
          body: JSON.stringify({
            box: selection,
            language: ocrLanguage,
            run_ocr: true,
          }),
        });
        setSelected(added.id);
        setDraft(draftOf(added));
        await client.invalidateQueries({ queryKey: ["regions", page.id] });
        await client.invalidateQueries({ queryKey: ["project", id] });
        setNotice("Region added. OCR is running on your selection.");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    } else if (draft) {
      if (drawMode === "source") change({ source_box: selection });
      if (drawMode === "include")
        change({ mask_include: [...draft.mask_include, selection] });
      if (drawMode === "exclude")
        change({ mask_exclude: [...draft.mask_exclude, selection] });
      setNotice(
        "Mask selection updated. Save changes to reconstruct and preview.",
      );
    }
    setSelection(null);
    setDrawMode("");
  }
  function change(patch: Partial<Draft>) {
    if (!draft) return;
    dirty.current = true;
    setUndo((u) => [...u.slice(-49), draft]);
    setRedo([]);
    setDraft({ ...draft, ...patch });
  }
  async function save() {
    if (!draft || !region) return;
    setBusy(true);
    setError("");
    try {
      await api("/regions/" + region.id, {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      dirty.current = false;
      setNotice("Saved. This page is being rendered again.");
      client.invalidateQueries({ queryKey: ["project", id] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retranslate() {
    if (!region) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<Region>("/regions/" + region.id + "/retranslate", {
        method: "POST",
      });
      setDraft(draftOf(r));
      setNotice("Retranslated saved source text; rendering this page.");
      client.invalidateQueries({ queryKey: ["project", id] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!p)
    return (
      <main className="workspace">
        {loadError?.message || "Opening editor…"}
      </main>
    );
  return (
    <main className="workspace editor-workspace">
      <div className="page-heading">
        <div>
          <Link className="back-link" href={"/projects/" + id}>
            <ArrowLeft size={15} /> {p.title}
          </Link>
          <h1>Make every word count.</h1>
        </div>
        <Link className="button outline" href={"/read/" + id}>
          <BookOpen size={16} /> Reader
        </Link>
      </div>
      <div className="editor-toolbar">
        <label>
          Page{" "}
          <select
            aria-label="Editor page"
            value={index}
            onChange={(e) => {
              setIndex(+e.target.value);
              setSelected("");
              setDraft(null);
            }}
          >
            {p.pages.map((page, i) => (
              <option key={page.id} value={i}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented">
          {["original", "clean", "translated", "mask", "candidate"].map((v) => (
            <button
              key={v}
              className={v === view ? "selected" : ""}
              onClick={() => setView(v)}
            >
              {v === "candidate" ? "Proposed mask" : v}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          disabled={busy || p.active}
          onClick={() => {
            setDrawMode(drawMode === "add" ? "" : "add");
            setView("original");
          }}
        >
          Add Text Region
        </Button>
        <label className="check-field">
          <input type="checkbox" checked={showRegions} onChange={(e) => setShowRegions(e.target.checked)} />
          Show region boxes
        </label>
        <label>
          OCR language{" "}
          <select
            aria-label="Recovery source language"
            value={ocrLanguage}
            onChange={(e) => setOcrLanguage(e.target.value)}
          >
            {["ja", "en", "ko", "zh-CN", "zh-TW", "ru"].map((l) => (
              <option key={l} value={l}>
                {languages[l]}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          disabled={busy || p.active || !page}
          onClick={() =>
            recover("/pages/" + page!.id + "/ocr", { source_lang: ocrLanguage })
          }
        >
          Retry page OCR
        </Button>
        <span className="hint">
          {drawMode
            ? "Drag around the area on the original page. Click the active tool to cancel."
            : "Select a text region to edit it."}
        </span>
      </div>
      {view === "mask" && (
        <p className="hint">White pixels are the removal mask actually applied to Clean. Numbered outlines show detected regions, including those left unchanged for review.</p>
      )}
      {view === "candidate" && (
        <p className="hint">Pink pixels are the selected region’s proposed mask on the original page. They are diagnostic only; compare with Mask to see what was actually removed. Save mask edits before previewing them.</p>
      )}
      {page && (
        <div className="editor-layout">
          <div
            className="editor-image-wrap"
            style={{
              touchAction: drawMode ? "none" : "auto",
              cursor: drawMode ? "crosshair" : "auto",
            }}
            onPointerDown={(e) => {
              if (!drawMode || p.active || busy) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              const start = point(e);
              setDrawStart(start);
              setSelection([...start, 0, 0]);
            }}
            onPointerMove={(e) => {
              if (!drawStart) return;
              const end = point(e);
              setSelection([
                Math.min(drawStart[0], end[0]),
                Math.min(drawStart[1], end[1]),
                Math.abs(end[0] - drawStart[0]),
                Math.abs(end[1] - drawStart[1]),
              ]);
            }}
            onPointerUp={() => {
              if (drawStart) void finishDrawing();
            }}
            onPointerCancel={() => {
              setDrawStart(null);
              setSelection(null);
            }}
          >
            <img
              src={
                view === "original" || !ready(page)
                  ? page.original
                  : view === "candidate"
                  ? region
                    ? "/api/regions/" + region.id + "/mask-candidate?v=" + page.revision
                    : page.original
                  : "/api/pages/" +
                    page.id +
                    "/image/" +
                    view +
                    "?v=" +
                    page.revision
              }
              alt={"Page " + (index + 1) + " " + view}
              draggable={false}
            />
            {showRegions && regions?.map((r, i) => (
              <button
                key={r.id}
                className={
                  "region-box " + diagnosticTone(r) + " " + (selected === r.id ? "selected" : "")
                }
                aria-label={"Edit region " + (i + 1) + ", " + String(r.render.diagnostic_status || "needs review")}
                title={String(r.render.diagnostic_status || "needs review") + ": " + String(r.render.failure_reason || r.source_text || "No text")}
                style={{
                  pointerEvents: drawMode ? "none" : "auto",
                  left: (r.box[0] / page.width) * 100 + "%",
                  top: (r.box[1] / page.height) * 100 + "%",
                  width: (r.box[2] / page.width) * 100 + "%",
                  height: (r.box[3] / page.height) * 100 + "%",
                }}
                onClick={() => {
                  setSelected(r.id);
                  draftRegion.current = r.id;
                  dirty.current = false;
                  setDraft(draftOf(r));
                }}
              >
                <span>{i + 1}</span>
              </button>
            ))}
            {selection && (
              <div
                aria-label="New region selection"
                style={{
                  position: "absolute",
                  pointerEvents: "none",
                  border: "2px solid #b7a1ff",
                  background: "#b7a1ff33",
                  left: (selection[0] / page.width) * 100 + "%",
                  top: (selection[1] / page.height) * 100 + "%",
                  width: (selection[2] / page.width) * 100 + "%",
                  height: (selection[3] / page.height) * 100 + "%",
                }}
              />
            )}
          </div>
          <aside className="panel editor-panel">
            {region && draft ? (
              <>
                <div className="panel-heading">
                  <h2>Dialogue {regions!.indexOf(region) + 1}</h2>
                  <span className="badge">
                    {region.render.ocr_confidence_available === false
                      ? "OCR confidence unavailable"
                      : `OCR ${Math.round(region.confidence * 100)}%`}
                  </span>
                </div>
                <svg
                  className="source-crop"
                  viewBox={region.box.join(" ")}
                  role="img"
                  aria-label="Original text crop"
                >
                  <image
                    href={page.original}
                    width={page.width}
                    height={page.height}
                  />
                </svg>
                {region.warnings.map((w, i) => (
                  <div className="note" key={i}>
                    {w}
                  </div>
                ))}
                <p className="hint">
                  Stage:{" "}
                  {String(region.render.diagnostic_status || region.render.state || "detected").replaceAll(
                    "_",
                    " ",
                  )}
                </p>
                <details className="region-diagnostics">
                  <summary>Region diagnostics</summary>
                  <p className="hint">ID: {region.id}</p>
                  <p className="hint">Type: {String(region.render.classification || region.kind || "unclassified").replaceAll("_", " ")} · evidence: {String(region.render.text_evidence || "unrated")}</p>
                  <p className="hint">Language: {region.language} · OCR: {String(region.render.ocr_engine || "manual")}</p>
                  <p className="hint">Source: {region.source_text || "No text recognized"}</p>
                  <p className="hint">Translation: {region.translation || "Pending"}</p>
                  <p className="hint">
                    Mask: {String(region.render.mask_status || "not checked").replaceAll("_", " ")} · {String(region.render.mask_candidate_pixels ?? 0)} candidate pixels · {String(region.render.mask_applied_pixels ?? 0)} applied pixels
                  </p>
                  {Boolean(region.render.mask_failure_reason) && <p className="note">{String(region.render.mask_failure_reason)}</p>}
                  {Boolean(region.render.failure_reason) && <p className="note">{String(region.render.failure_reason)}</p>}
                  {Boolean(region.render.stage_statuses) && (
                    <div>
                      <strong>Current stages</strong>
                      <ul className="region-stage-list">
                        {Object.entries(region.render.stage_statuses as Record<string, { status: string; reason?: string }>).map(([stage, result]) => (
                          <li key={stage}>{stage}: {result.status.replaceAll("_", " ")}{result.reason ? ": " + result.reason : ""}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {Array.isArray(region.render.stage_history) && (
                    <ol className="region-stage-list">
                      {(region.render.stage_history as { status: string; reason?: string; at?: number }[]).map((step, i) => (
                        <li key={i}>{step.status.replaceAll("_", " ")}{step.reason ? ": " + step.reason : ""}</li>
                      ))}
                    </ol>
                  )}
                </details>
                {typeof region.render.ocr_suggestion === "string" && (
                  <div className="note">
                    <p>OCR suggestion: {region.render.ocr_suggestion}</p>
                    <Button
                      variant="outline"
                      onClick={() =>
                        change({
                          source_text: String(region.render.ocr_suggestion),
                          source_verified: false,
                        })
                      }
                    >
                      Use OCR suggestion
                    </Button>
                  </div>
                )}
                {Boolean(region.render.ocr_cloud_suggestion) && (
                  <div className="note">
                    <p>OCR.space crop suggestion: {String(region.render.ocr_cloud_suggestion)}</p>
                    <Button
                      variant="outline"
                      onClick={() => change({ source_text: String(region.render.ocr_cloud_suggestion), source_verified: false })}
                    >
                      Use crop suggestion
                    </Button>
                  </div>
                )}
                <Button
                  variant="outline"
                  disabled={busy || p.active}
                  onClick={() => recover("/regions/" + region.id + "/ocr")}
                >
                  Retry region OCR
                </Button>
                <div className="actions">
                  {(["mask", "clean", "render"] as const).map((stage) => (
                    <Button
                      key={stage}
                      variant="outline"
                      disabled={busy || p.active}
                      onClick={() => recover(
                        "/regions/" + region.id + "/retry/" + stage,
                        undefined,
                        `${stage === "mask" ? "Mask regeneration" : stage === "clean" ? "Cleanup" : "Typesetting"} queued for this region. Saved OCR and translations will be reused.`,
                      )}
                    >
                      {stage === "mask" ? "Regenerate mask" : stage === "clean" ? "Retry cleanup" : "Retry rendering"}
                    </Button>
                  ))}
                </div>
                <label className="field">
                  Recognized source
                  <textarea
                    rows={3}
                    value={draft.source_text}
                    onChange={(e) => change({ source_text: e.target.value })}
                  />
                </label>
                <label className="field">
                  Source language
                  <select
                    value={draft.language}
                    onChange={(e) => change({ language: e.target.value })}
                  >
                    {["ja", "en", "ko", "zh-CN", "zh-TW", "ru"].map((l) => (
                      <option value={l} key={l}>
                        {languages[l]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Translation
                  <textarea
                    rows={4}
                    value={draft.translation}
                    onChange={(e) => change({ translation: e.target.value })}
                  />
                </label>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={draft.source_verified}
                    onChange={(e) =>
                      change({ source_verified: e.target.checked })
                    }
                  />{" "}
                  I verified the source text
                </label>
                <details>
                  <summary>Text removal mask</summary>
                  <p className="hint">
                    Select source lettering separately from the English
                    placement box. Include and protect selections affect ink
                    pixels only.
                  </p>
                  {(
                    [
                      ["source", "Select source lettering"],
                      ["include", "Include ink area"],
                      ["exclude", "Protect artwork area"],
                    ] as const
                  ).map(([mode, label]) => (
                    <Button
                      key={mode}
                      variant="outline"
                      disabled={busy || p.active}
                      onClick={() => {
                        setDrawMode(drawMode === mode ? "" : mode);
                        setView("original");
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                  <label className="field">
                    Mask expansion (pixels)
                    <input
                      type="number"
                      min={0}
                      max={4}
                      value={draft.mask_dilation}
                      onChange={(e) =>
                        change({ mask_dilation: +e.target.value })
                      }
                    />
                  </label>
                  <p>
                    {draft.mask_include.length} included areas ·{" "}
                    {draft.mask_exclude.length} protected areas
                  </p>
                  <Button
                    variant="outline"
                    onClick={() =>
                      change({ mask_include: [], mask_exclude: [] })
                    }
                  >
                    Reset mask adjustments
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || p.active}
                    onClick={save}
                  >
                    Rebuild cleanup and preview
                  </Button>
                </details>
                <div className="form-grid">
                  <label className="field">
                    Maximum font size
                    <input
                      type="number"
                      min={12}
                      max={100}
                      value={draft.font_size}
                      onChange={(e) => change({ font_size: +e.target.value })}
                    />
                  </label>
                  <label className="field">
                    Alignment
                    <select
                      value={draft.align}
                      onChange={(e) => change({ align: e.target.value })}
                    >
                      {["left", "center", "right"].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  {["offset_x", "offset_y"].map((key) => (
                    <label className="field" key={key}>
                      {key === "offset_x"
                        ? "Horizontal offset"
                        : "Vertical offset"}
                      <input
                        type="number"
                        value={draft[key as "offset_x" | "offset_y"]}
                        onChange={(e) => change({ [key]: +e.target.value })}
                      />
                    </label>
                  ))}
                  {["x", "y", "width", "height"].map((label, i) => (
                    <label key={label} className="field">
                      Box {label}
                      <input
                        type="number"
                        value={draft.box[i]}
                        onChange={(e) =>
                          change({
                            box: draft.box.map((n, j) =>
                              i === j ? +e.target.value : n,
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <p className="hint">
                  Noto Sans CJK · automatic fitting down to 12px. Position and
                  box changes never rerun OCR.
                </p>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={draft.restored}
                    onChange={(e) => change({ restored: e.target.checked })}
                  />{" "}
                  Preserve original lettering in this region
                </label>
                <p className="hint">Use this for sound effects or lettering you want to keep.</p>
                <div className="actions">
                  <button
                    className="icon-button"
                    aria-label="Undo edit"
                    disabled={!undo.length}
                    onClick={() => {
                      setRedo((r) => [...r, draft]);
                      setDraft(undo[undo.length - 1]);
                      setUndo(undo.slice(0, -1));
                    }}
                  >
                    <Undo2 size={18} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Redo edit"
                    disabled={!redo.length}
                    onClick={() => {
                      setUndo((u) => [...u, draft]);
                      setDraft(redo[redo.length - 1]);
                      setRedo(redo.slice(0, -1));
                    }}
                  >
                    <Redo2 size={18} />
                  </button>
                  <Button
                    variant="outline"
                    onClick={retranslate}
                    disabled={busy || p.active}
                  >
                    <RotateCcw size={15} /> Retranslate saved text
                  </Button>
                </div>
                <Button disabled={busy || p.active} onClick={save}>
                  <Save size={17} /> {p.active ? "Rendering…" : "Save changes"}
                </Button>
                <label className="field">
                  Quality feedback
                  <select
                    defaultValue=""
                    onChange={async (e) => {
                      if (e.target.value) {
                        try {
                          await api("/regions/" + region.id + "/feedback", {
                            method: "POST",
                            body: JSON.stringify({ category: e.target.value }),
                          });
                          setNotice("Feedback recorded.");
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }
                    }}
                  >
                    <option value="">Choose feedback…</option>
                    {[
                      "correct",
                      "incorrect_translation",
                      "incorrect_ocr",
                      "poor_placement",
                      "damaged_artwork",
                    ].map((v) => (
                      <option key={v} value={v}>
                        {v.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <div className="empty">
                <h3>No detected regions yet.</h3>
                <p>
                  Click Add Text Region and draw around dialogue to recognize or
                  enter its text manually.
                </p>
                <Link className="button outline" href={"/projects/" + id}>
                  Chapter dashboard
                </Link>
              </div>
            )}
            {Array.isArray(page.metrics.ocr_attempts) && (
              <details>
                <summary>Recognition details</summary>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                  {JSON.stringify(page.metrics.ocr_attempts, null, 2)}
                </pre>
              </details>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className="note" role="status">
                {notice}
              </div>
            )}
          </aside>
        </div>
      )}
      <section className="panel glossary">
        <h2>Chapter glossary</h2>
        <p>
          One entry per line: source = translation. LLM providers receive all
          terms as context; other providers apply exact whole-region matches.
        </p>
        <textarea
          aria-label="Glossary entries"
          rows={4}
          value={glossaryText}
          onChange={(e) => setGlossaryText(e.target.value)}
          placeholder="アキラ = Akira"
        />
        <Button
          variant="outline"
          disabled={p.active}
          onClick={async () => {
            try {
              const entries = glossaryText
                .split("\n")
                .filter((s) => s.trim())
                .map((s) => {
                  const i = s.indexOf("=");
                  if (i < 1)
                    throw new Error(
                      "Use source = translation for each glossary entry.",
                    );
                  return {
                    source: s.slice(0, i).trim(),
                    target: s.slice(i + 1).trim(),
                  };
                });
              await api("/projects/" + id + "/glossary", {
                method: "PUT",
                body: JSON.stringify(entries),
              });
              setNotice("Glossary saved for future translations.");
              setError("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Save glossary
        </Button>
      </section>
    </main>
  );
}
