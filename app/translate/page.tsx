"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Upload,
  ArrowRight,
  ArrowLeft,
  Link2,
  FileImage,
  X,
  ShieldCheck,
  Check,
} from "lucide-react";
import { api, Health, Project, languages } from "@/lib/api";
import { usePreferences } from "@/lib/store";
import { Button } from "@/components/ui/button";
export default function Translate() {
  const router = useRouter();
  const prefs = usePreferences();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const [error, setError] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [source, setSource] = useState("ja");
  const [target, setTarget] = useState(prefs.target);
  const [quality, setQuality] = useState(prefs.quality);
  const [style, setStyle] = useState(prefs.style);
  const [provider, setProvider] = useState("deepl");
  const [direction, setDirection] = useState("rtl");
  const [previews, setPreviews] = useState<string[]>([]);
  const {
    data: health,
    error: healthError,
    refetch: reloadServices,
  } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<Health>("/health"),
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (health && !health.providers[provider])
      setProvider(health.default_provider);
  }, [health, provider]);
  useEffect(() => {
    if (health?.execution_mode === "browser") {
      setQuality("quality");
      setStyle("natural");
    }
  }, [health?.execution_mode]);
  const offlineUnavailable = (language: string) =>
    provider === "argos" &&
    source !== "auto" &&
    source !== language &&
    health?.offline_pairs !== undefined &&
    !health.offline_fallback_available &&
    !health.offline_pairs.some(
      (pair) => pair.source === source && pair.target === language,
    );
  const missingModel = offlineUnavailable(target);
  useEffect(() => {
    setUrl(new URLSearchParams(location.search).get("url") || "");
  }, []);
  useEffect(() => {
    const urls = files.map((f) =>
      f.type.startsWith("image/") ? URL.createObjectURL(f) : "",
    );
    setPreviews(urls);
    return () => urls.forEach((u) => u && URL.revokeObjectURL(u));
  }, [files]);
  function select(list: FileList | null) {
    if (list) {
      setFiles(
        Array.from(list).sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        ),
      );
      setUrl("");
      setError("");
    }
  }
  async function importPages() {
    setError("");
    setBusy(true);
    try {
      if (!health)
        throw new Error(
          "Wait for processing services to connect before importing pages.",
        );
      let result: Project;
      if (health?.execution_mode === "browser") {
        const { importCloud } = await import("@/lib/browser-pages");
        result = await importCloud(files, title, authorized, setImportStatus);
      } else if (files.length) {
        const form = new FormData();
        files.forEach((f) => form.append("files", f));
        form.append("title", title || files[0].name.replace(/\.[^.]+$/, ""));
        form.append("authorized", String(authorized));
        result = await api("/projects/upload", { method: "POST", body: form });
      } else
        result = await api("/projects/import", {
          method: "POST",
          body: JSON.stringify({ url, authorized }),
        });
      setProject(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setImportStatus("");
    }
  }
  async function start() {
    if (!project) return;
    setBusy(true);
    setError("");
    try {
      await api("/projects/" + project.id + "/start", {
        method: "POST",
        body: JSON.stringify({
          source_lang: source,
          target_lang: target,
          quality,
          style,
          provider,
          direction,
          order: project.pages.map((p) => p.id),
        }),
      });
      router.push("/projects/" + project.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function move(index: number, delta: number) {
    if (!project) return;
    const pages = [...project.pages];
    [pages[index], pages[index + delta]] = [pages[index + delta], pages[index]];
    setProject({ ...project, pages });
  }
  return (
    <main className="workspace narrow">
      <div className="eyebrow">YOUR STORY STARTS HERE</div>
      <h1>Open a new chapter.</h1>
      <p className="lead">
        Bring your pages. We’ll help you read between the languages.
      </p>
      <div className="import-layout">
        <section className="panel upload-panel">
          <div className="panel-heading">
            <span className="step">01</span>
            <h2>Import your pages</h2>
          </div>
          <label className="field">
            Chapter title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="A title for your library"
              maxLength={200}
            />
          </label>
          <div
            className="dropzone"
            role="button"
            tabIndex={0}
            onClick={() => input.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") input.current?.click();
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              select(e.dataTransfer.files);
            }}
          >
            <div className="upload-orb">
              <Upload size={26} />
            </div>
            <h3>Drop a chapter into a new world</h3>
            <p>
              Drag your files here, or <span>browse files</span>
            </p>
            <small>
              JPG, PNG, WebP, ZIP, CBZ or PDF · {health?.max_upload_mb || 64} MB
              total
            </small>
            <input
              ref={input}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.zip,.cbz,.pdf"
              multiple
              hidden
              onChange={(e) => select(e.target.files)}
            />
          </div>
          {files.length > 0 && (
            <div className="file-list">
              {files.map((f, i) => (
                <div key={i}>
                  {previews[i] ? (
                    <img src={previews[i]} alt="" />
                  ) : (
                    <FileImage size={22} />
                  )}
                  <span>
                    {f.name}
                    <small>{(f.size / 1024 / 1024).toFixed(1)} MB</small>
                  </span>
                  <button
                    className="icon-button"
                    aria-label={"Remove " + f.name}
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {health && health.execution_mode !== "browser" && (
            <>
              <div className="divider-label">
                OR IMPORT AN AUTHORIZED SOURCE
              </div>
              <label className="input-icon">
                <Link2 size={18} />
                <input
                  aria-label="Supported chapter URL"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setFiles([]);
                  }}
                  placeholder="https://your-source.com/chapter.json"
                />
              </label>
              <p className="hint">
                {health?.source_hosts.length
                  ? "Enabled hosts: " + health.source_hosts.join(", ")
                  : "No remote sources are enabled. Upload your files, or configure an authorized JSON manifest host on the server."}
              </p>
            </>
          )}
          <label className="check-field">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(e) => setAuthorized(e.target.checked)}
            />
            <span>I have permission to upload and translate this content.</span>
          </label>
          {error && !project && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <Button
            disabled={
              !health ||
              busy ||
              !authorized ||
              (health?.execution_mode === "browser"
                ? !files.length || !health.storage_configured
                : !files.length && !url)
            }
            onClick={importPages}
          >
            {busy
              ? "Importing pages…"
              : !health
                ? "Connecting services…"
                : "Preview chapter"}
            <ArrowRight size={17} />
          </Button>
          {busy && (
            <p role="status" className="hint">
              {importStatus || "Importing your pages…"}
            </p>
          )}
          {healthError && (
            <div role="alert" className="error">
              Processing services could not connect.{" "}
              <Button
                variant="outline"
                onClick={() => {
                  void reloadServices();
                }}
              >
                Retry connection
              </Button>
            </div>
          )}
          {health?.execution_mode === "browser" && (
            <p className="hint">
              Up to 20 pages · 12 megapixels per page · 8 MB per page after PNG
              conversion. Keep this tab open while translating.
            </p>
          )}
          {health?.execution_mode === "browser" &&
            !health.storage_configured && (
              <p role="alert" className="error">
                Cloud storage setup is pending. Imports will become available
                when Supabase is configured.
              </p>
            )}
        </section>
        <aside className="import-aside">
          <div className="eyebrow">A LITTLE PEACE OF MIND</div>
          <h2>
            Your pages.
            <br />
            Your space.
          </h2>
          <p>
            Projects belong to this private browser session. Original files stay
            separate from every translated result.
          </p>
          <ul>
            <li>
              <ShieldCheck size={18} /> Private, permission-based imports
            </li>
            <li>
              <Check size={18} /> Editable text and translations
            </li>
            <li>
              <Check size={18} /> Projects expire after{" "}
              {health?.retention_days || 7} days
            </li>
          </ul>
          <div className="note">
            Automatic translation is imperfect. Always review the dialogue and
            artwork before exporting.
          </div>
        </aside>
      </div>
      <Dialog.Root
        open={!!project}
        onOpenChange={(open) => {
          if (!open) setProject(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal">
            <Dialog.Title>One last look at your chapter.</Dialog.Title>
            <Dialog.Description>
              Set the reading order and translation preferences. Your imported
              project is already saved.
            </Dialog.Description>
            <Dialog.Close
              className="modal-close icon-button"
              aria-label="Close"
            >
              <X size={20} />
            </Dialog.Close>
            {project && (
              <>
                <div className="chapter-meta">
                  <b>{project.title}</b>
                  <span>
                    {project.pages.length} pages ·{" "}
                    {project.source === "Upload"
                      ? "Local upload"
                      : "Authorized source"}
                  </span>
                </div>
                <div className="thumbnail-strip">
                  {project.pages.map((p, i) => (
                    <div key={p.id}>
                      <img src={p.thumbnail} alt={p.name} />
                      <div>
                        <button
                          aria-label={"Move page " + (i + 1) + " earlier"}
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                        >
                          <ArrowLeft size={13} />
                        </button>
                        <span>{i + 1}</span>
                        <button
                          aria-label={"Move page " + (i + 1) + " later"}
                          disabled={i === project.pages.length - 1}
                          onClick={() => move(i, 1)}
                        >
                          <ArrowRight size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="form-grid">
                  <label className="field">
                    Source language
                    <select
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                    >
                      {["auto", "ja", "en", "ko", "zh-CN", "zh-TW", "ru"].map(
                        (l) => (
                          <option key={l} value={l}>
                            {languages[l]}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="field">
                    Translate into
                    <select
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    >
                      {Object.entries(languages)
                        .filter(([k]) => k !== "auto")
                        .map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                            {offlineUnavailable(k) ? " · Not installed" : ""}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field">
                    Translation provider
                    <select
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                    >
                      {(health?.execution_mode === "browser"
                        ? ["deepl"]
                        : [
                            "deepl",
                            "argos",
                            "openai",
                            "ollama",
                            "google",
                            "azure",
                          ]
                      ).map((p) => (
                        <option key={p} value={p}>
                          {p === "argos" ? "Argos · Offline CPU" : p}
                          {health && !health.providers[p]
                            ? " · Unconfigured"
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Reading order
                    <select
                      value={direction}
                      onChange={(e) => setDirection(e.target.value)}
                    >
                      <option value="rtl">Right to left · Manga</option>
                      <option value="ltr">Left to right</option>
                      <option value="vertical">Top to bottom · Webtoon</option>
                    </select>
                  </label>
                  <label className="field">
                    Processing profile
                    <select
                      value={quality}
                      onChange={(e) => setQuality(e.target.value)}
                    >
                      {health?.execution_mode === "browser" ? (
                        <option value="quality">
                          Cloud OCR · Review required
                        </option>
                      ) : (
                        <>
                          <option value="quality">Maximum Quality</option>
                          <option value="balanced">Balanced</option>
                          <option value="fast">Fast</option>
                        </>
                      )}
                    </select>
                  </label>
                  <label className="field">
                    Translation style
                    <select
                      value={style}
                      onChange={(e) => setStyle(e.target.value)}
                    >
                      {(health?.execution_mode === "browser"
                        ? ["natural"]
                        : ["faithful", "natural", "literal", "concise"]
                      ).map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {missingModel && (
                  <div role="alert" className="note">
                    {languages[source]} → {languages[target]} is not installed
                    for offline translation. Choose an installed pair or a
                    configured provider. Installed pairs are listed in Settings.
                  </div>
                )}
                {provider === "argos" && source === "auto" && (
                  <p className="hint">
                    With automatic detection, model availability can only be
                    checked after OCR. Select the source language to check
                    before starting.
                  </p>
                )}
                <p className="hint">
                  {health?.execution_mode === "browser"
                    ? "OCR.space receives page images and DeepL receives recognized dialogue. This tab coordinates processing and renders each result. Closing it pauses unfinished work; reopen the chapter to resume. Review recognized text and cleanup before exporting."
                    : "DeepL translates recognized dialogue using nearby text for context. Maximum Quality runs local OCR recovery. Configured OCR.space receives page images. Review uncertain regions before exporting."}
                </p>
                {error && (
                  <div role="alert" className="error">
                    {error}
                  </div>
                )}
                <Button disabled={busy || missingModel} onClick={start}>
                  {busy ? "Starting…" : "Translate Chapter"}
                  <ArrowRight size={17} />
                </Button>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
