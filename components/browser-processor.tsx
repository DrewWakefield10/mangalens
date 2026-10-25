"use client";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Health, type Project, type Region } from "@/lib/api";
import type { CloudPage, CloudProject } from "@/lib/cloud-types";
import { Button } from "./ui/button";
import Link from "next/link";
type Claim = { page: CloudPage; project: CloudProject; token: string };
let running = false;
export default function BrowserProcessor() {
  const client = useQueryClient();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [chapter, setChapter] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stopped = false;
    let hasWork = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function cycle() {
      if (stopped) return;
      if (running || !navigator.onLine) {
        timer = setTimeout(cycle, 5000);
        return;
      }
      running = true;
      try {
        const health = await api<Health>("/health", {
          signal: controller.signal,
        });
        if (health.execution_mode !== "browser" || !health.storage_configured)
          return;
        const projects = await api<Project[]>("/projects", {
          signal: controller.signal,
        });
        const active = projects.find((p) => p.active && !p.cancelled);
        if (!active) {
          setMessage("");
          return;
        }
        setChapter(active.id);
        hasWork = true;
        const process = async () => {
          const claim = await api<Claim | null>(
            "/projects/" + active.id + "/claim",
            { method: "POST", signal: controller.signal },
          );
          if (!claim) return;
          const { page, token } = claim;
          try {
            const { makeTiles, renderPage } =
              await import("@/lib/browser-render");
            const { uploadImage } = await import("@/lib/browser-pages");
            setMessage("Preparing " + page.name + "… Keep this tab open.");
            const response = await fetch(
              "/api/pages/" + page.id + "/image/original",
              { signal: controller.signal },
            );
            if (!response.ok)
              throw new Error(
                "The original page could not be loaded. Resume the chapter to retry.",
              );
            const bitmap = await createImageBitmap(await response.blob());
            try {
              if (!page.translated) {
                const tiles = await makeTiles(bitmap);
                for (const tile of tiles) {
                  if (stopped)
                    throw new DOMException("Processing paused", "AbortError");
                  if (page.tiles_done.includes(tile.index)) continue;
                  setMessage(
                    "Recognizing " +
                      page.name +
                      " · tile " +
                      (tile.index + 1) +
                      " of " +
                      tiles.length +
                      ". Keep this tab open.",
                  );
                  await api("/pages/" + page.id + "/recognize", {
                    method: "POST",
                    body: JSON.stringify({ token, tile }),
                    signal: controller.signal,
                  });
                }
              }
              if (Number(page.metrics.layout_version || 0) < 2) {
                setMessage(
                  "Arranging dialogue on " +
                    page.name +
                    ". Keep this tab open.",
                );
                const { layoutGroups } = await import("@/lib/page-layout");
                const { canvasOf } = await import("@/lib/browser-pages");
                const latest = await api<Region[]>(
                  "/pages/" + page.id + "/regions",
                  { signal: controller.signal },
                );
                const surface = canvasOf(bitmap.width, bitmap.height);
                const context = surface.getContext("2d", {
                  willReadFrequently: true,
                })!;
                context.drawImage(bitmap, 0, 0);
                const groups = layoutGroups(
                  context.getImageData(0, 0, bitmap.width, bitmap.height),
                  latest,
                );
                surface.width = surface.height = 0;
                await api("/pages/" + page.id + "/prepare", {
                  method: "POST",
                  body: JSON.stringify({ token, groups }),
                  signal: controller.signal,
                });
              }
              setMessage("Translating " + page.name + "… Keep this tab open.");
              const { regions } = await api<{ regions: Region[] }>(
                "/pages/" + page.id + "/translate",
                {
                  method: "POST",
                  body: JSON.stringify({ token }),
                  signal: controller.signal,
                },
              );
              setMessage("Rendering " + page.name + "… Keep this tab open.");
              const result = await renderPage(bitmap, page, regions);
              if (stopped)
                throw new DOMException("Processing paused", "AbortError");
              const urls = await api<Record<string, string>>(
                "/pages/" + page.id + "/output-urls",
                {
                  method: "POST",
                  body: JSON.stringify({ token }),
                  signal: controller.signal,
                },
              );
              for (const kind of ["translated", "clean", "mask"] as const) {
                if (result[kind].size > 8 * 1024 * 1024)
                  throw new Error(
                    "The rendered page exceeds 8 MB. Use a smaller image.",
                  );
                await uploadImage(urls[kind], result[kind], controller.signal);
              }
              await api("/pages/" + page.id + "/commit", {
                method: "POST",
                body: JSON.stringify({
                  token,
                  warnings: result.warnings,
                  diagnostics: result.diagnostics,
                }),
                signal: controller.signal,
              });
              setError("");
              setMessage("");
              await client.invalidateQueries({
                queryKey: ["project", active.id],
              });
              await client.invalidateQueries({
                queryKey: ["regions", page.id],
              });
              await client.invalidateQueries({ queryKey: ["projects"] });
            } finally {
              bitmap.close();
            }
          } catch (cause) {
            if (cause instanceof Error && cause.name === "AbortError") return;
            const detail =
              cause instanceof Error
                ? cause.message
                : "Processing stopped. Resume this chapter to retry.";
            await api("/pages/" + page.id + "/failed", {
              method: "POST",
              body: JSON.stringify({ token, message: detail }),
            }).catch(() => {});
            setMessage("");
            setError(detail);
          }
        };
        // Web Locks elect one processing tab; server leases also protect browsers without it.
        if (navigator.locks)
          await navigator.locks.request(
            "mangalens-processing",
            { ifAvailable: true },
            (lock) => (lock ? process() : Promise.resolve()),
          );
        else await process();
      } catch (cause) {
        if (!stopped && hasWork)
          setError(
            cause instanceof Error
              ? cause.message
              : "Connection lost. Resume when online.",
          );
      } finally {
        running = false;
        if (!stopped) timer = setTimeout(cycle, 5000);
      }
    }
    cycle();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, retry]);
  useEffect(() => {
    if (!message) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [message]);
  if (!message && !error) return null;
  return (
    <aside className="browser-processing" aria-label="Chapter processing">
      <div role={error ? "alert" : "status"} aria-live="polite">
        {error || message}
        <small>
          Progress is saved after each stage. If you close the tab, reopen the
          chapter and resume; an interrupted page may take up to five minutes to
          unlock.
        </small>
      </div>
      <Link className="text-link" href={"/projects/" + chapter}>
        Open chapter
      </Link>
      {error && (
        <Button
          variant="outline"
          onClick={() => {
            setError("");
            setRetry((n) => n + 1);
          }}
        >
          Check connection
        </Button>
      )}
    </aside>
  );
}
