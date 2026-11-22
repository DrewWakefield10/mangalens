import { ordered, union } from "@/lib/page-layout";
import {
  approved,
  BUBBLE_VERSION,
  polygonBox,
  polygonRows,
} from "@/lib/bubble-geometry";
import {
  configureBubbles,
  maskedTile,
  readOcrPage,
  requireReview,
  saveReview,
  scanBubbles,
  validRegion,
  verifyApprovedPixels,
} from "@/lib/cloud-bubbles";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { Region } from "@/lib/api";
import { BOUNDARY, CLEANUP, OCR_DEFERRED, TOO_LONG, type LayoutDebug } from "@/lib/render-feedback";
import {
  CLOUD_LIMITS as L,
  type CloudPage,
  type CloudProject,
  type Document,
} from "@/lib/cloud-types";
import {
  configured,
  db,
  document,
  fail,
  gateway,
  HttpError,
  list,
  mutate,
  owner,
  pageDto,
  pathFor,
  projectDto,
  signed,
  uuid,
  verifyPng,
  cleanup,
} from "@/lib/cloud-store";
import { OCRRateLimitError, recognize, translate } from "@/lib/cloud-providers";
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
function integer(value: unknown, min: number, max: number) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    fail(400, "Invalid number or image dimensions.");
  return value as number;
}
function text(value: unknown, max = 200) {
  if (typeof value !== "string" || value.length > max)
    fail(400, "Text is missing or exceeds its size limit.");
  return value as string;
}
function box(value: unknown, p: CloudPage) {
  if (!Array.isArray(value) || value.length !== 4)
    return fail(400, "Select a valid region.");
  const [x, y, w, h] = value.map((v) =>
    integer(v, 0, Math.max(p.width, p.height)),
  );
  if (w < 1 || h < 1 || x + w > p.width || y + h > p.height)
    fail(400, "The selected region extends outside the page.");
  return [x, y, w, h];
}
async function body(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 1_600_000)
    fail(413, "This request is too large. Upload images directly to storage.");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return fail(400, "Invalid request data.");
  }
}
function lease(page: CloudPage, token: unknown) {
  if (
    !page.lease ||
    page.lease.token !== token ||
    page.lease.until < Date.now()
  )
    fail(
      409,
      "This page is being processed in another tab, or its processing lease expired. Resume the chapter.",
    );
}
async function findRegion(id: string, who: string) {
  uuid(id);
  const matches = await db<Document<CloudPage>>("ml_documents", "GET", {
    owner: "eq." + who,
    kind: "eq.page",
    "data->regions": "cs." + JSON.stringify([{ id }]),
    expires_at: "gt." + new Date().toISOString(),
    limit: "1",
  });
  const doc = matches[0];
  if (!doc) return fail(404, "This region is unavailable in your session.");
  return doc;
}
function checkMutation(req: NextRequest) {
  if (req.headers.get("x-mangalens-client") !== "web")
    fail(403, "Missing MangaLens client header.");
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin)
    fail(403, "This request came from an untrusted origin.");
}
async function handler(req: NextRequest, ctx: Context) {
  try {
    const parts = (await ctx.params).path;
    const route = "/" + parts.join("/");
    const method = req.method;
    if (method !== "GET") checkMutation(req);
    if (route === "/health" && method === "GET")
      return json({
        status: configured() ? "ok" : "setup_required",
        execution_mode: "browser",
        storage_configured: configured(),
        providers: { deepl: Boolean(process.env.DEEPL_API_KEY) },
        default_provider: "deepl",
        cloud_ocr_available: Boolean(process.env.OCR_SPACE_API_KEY),
        cloud_ocr_provider: "ocr_space",
        ocr_space_engine3_fallback: false,
        ocr_languages: [],
        offline_pairs: [],
        offline_fallback_available: false,
        font_available: true,
        retention_days: 7,
        source_hosts: [],
        max_upload_mb: 64,
        max_pages: L.maxPages,
      });
    if (route === "/session" && method === "POST") {
      await owner(true);
      return json({ ok: true, execution_mode: "browser" });
    }
    const who = await owner();
    if (route === "/preferences" && method === "PUT") {
      const preferences = await body(req);
      await db("ml_sessions", "PATCH", { id: "eq." + who }, { preferences });
      return json({ ok: true });
    }
    if (route === "/cache" && method === "DELETE") return json({ ok: true });
    if (route === "/projects" && method === "GET") {
      await cleanup();
      const docs = await list<CloudProject>(who, "project");
      return json(await Promise.all(docs.map((d) => projectDto(d, who))));
    }
    if (route === "/projects" && method === "POST") {
      const input = await body(req);
      if (input.authorized !== true)
        fail(400, "Confirm you have permission to import this content.");
      if ((await list(who, "project")).length >= 10)
        fail(429, "Delete an old chapter before creating another one.");
      const id = randomUUID();
      const data: CloudProject = {
        id,
        title: text(input.title || "Untitled chapter"),
        created: Date.now() / 1000,
        source: "Upload",
        source_lang: "ja",
        target_lang: "en",
        quality: "quality",
        style: "natural",
        provider: "deepl",
        direction: "rtl",
        last_page: 0,
        cancelled: true,
        glossary: [],
      };
      await db(
        "ml_documents",
        "POST",
        {},
        { id, owner: who, kind: "project", data },
      );
      return json(
        await projectDto(await document<CloudProject>(id, who, "project"), who),
        201,
      );
    }
    if (parts[0] === "projects" && parts[1]) {
      const project = await document<CloudProject>(parts[1], who, "project");
      const id = project.id;
      if (parts.length === 2) {
        if (method === "GET") return json(await projectDto(project, who));
        if (method === "DELETE") {
          const pages = await list<CloudPage>(who, "page", id);
          if (
            pages.some((p) =>
              ["queued", "processing", "rendering"].includes(p.data.status),
            )
          )
            fail(409, "Pause this chapter before deleting it.");
          for (const p of pages) {
            const paths = [...Object.values(p.data.assets), ...p.data.garbage];
            if (p.data.lease)
              for (const kind of ["translated", "clean", "mask"])
                paths.push(pathFor(who, p.id, kind, p.data.lease.token));
            if (paths.length)
              await gateway({
                op: "remove",
                paths: Array.from(new Set(paths)).slice(0, 100),
              });
          }
          await db("ml_documents", "DELETE", {
            id: "eq." + id,
            owner: "eq." + who,
          });
          return json({ ok: true });
        }
      }
      if (parts[2] === "pages" && method === "POST") {
        const input = await body(req);
        if (
          !Array.isArray(input.pages) ||
          !input.pages.length ||
          input.pages.length > L.maxPages
        )
          fail(400, "Import between 1 and 20 pages.");
        const pages: CloudPage[] = input.pages.map(
          (item: Record<string, unknown>, i: number) => {
            const width = integer(item.width, 1, 12000),
              height = integer(item.height, 1, 12000);
            if (width * height > L.maxPixels)
              fail(400, "A page exceeds the 12-megapixel limit.");
            integer(item.bytes, 24, L.maxFileBytes);
            const page = randomUUID();
            return {
              id: page,
              project_id: id,
              position: i,
              name: text(item.name),
              width,
              height,
              status: "uploading",
              error: "",
              revision: 0,
              regions: [],
              metrics: {},
              uploaded: false,
              tiles_done: [],
              tile_count: 0,
              translated: false,
              garbage: [],
              assets: {
                original: pathFor(who, page, "original", "0"),
                thumbnail: pathFor(who, page, "thumbnail", "0"),
              },
            };
          },
        );
        await gateway({
          op: "rpc",
          name: "ml_create_pages",
          body: { p_owner: who, p_project: id, p_pages: pages },
        });
        return json(
          await Promise.all(
            pages.map(async (p) => ({
              id: p.id,
              original: await signed(p.assets.original, true),
              thumbnail: await signed(p.assets.thumbnail, true),
            })),
          ),
          201,
        );
      }
      if (parts[2] === "bubble-scans" && method === "POST") {
        const input = await body(req);
        const pages = await list<CloudPage>(who, "page", id);
        const requested =
          input.page_ids == null
            ? pages.map((item) => item.id)
            : input.page_ids;
        if (
          !Array.isArray(requested) ||
          requested.some((pageId) => !pages.some((item) => item.id === pageId))
        )
          fail(404, "Page not found.");
        for (const item of pages) {
          if (
            !requested.includes(item.id) ||
            (item.data.bubble_scan?.version === BUBBLE_VERSION &&
              item.data.bubble_scan.status === "ready")
          )
            continue;
          const scan = await scanBubbles(item.data);
          await mutate<CloudPage>(
            item.id,
            who,
            (page) => ({ ...page, bubble_scan: scan }),
            item.version,
          );
        }
        return json(await projectDto(project, who));
      }
      if (parts[2] === "start" && method === "POST") {
        const input = await body(req);
        if (input.provider && input.provider !== "deepl")
          fail(400, "This hosted version supports DeepL translation.");
        const sources = ["auto", "ja", "en", "ko", "zh-CN", "zh-TW", "ru"];
        const targets = [
          "en",
          "ja",
          "ko",
          "zh-CN",
          "zh-TW",
          "ru",
          "es",
          "fr",
          "de",
          "pt",
          "id",
          "vi",
          "th",
          "tl",
        ];
        if (
          !sources.includes(input.source_lang) ||
          !targets.includes(input.target_lang)
        )
          fail(400, "Choose supported source and target languages.");
        const pages = await list<CloudPage>(who, "page", id);
        if (!pages.length || pages.some((p) => !p.data.uploaded))
          fail(400, "Finish importing every page before translating.");
        if (
          input.order &&
          (!Array.isArray(input.order) ||
            input.order.length !== pages.length ||
            new Set(input.order).size !== pages.length ||
            input.order.some((v: string) => !pages.some((p) => p.id === v)))
        )
          fail(400, "The reading order must contain every page once.");
        for (const item of pages) requireReview(item.data);
        if (
          pages.some(
            (item) => item.data.lease && item.data.lease.until > Date.now(),
          )
        )
          fail(409, "Pause processing before reviewing this chapter.");
        const changed =
          input.source_lang !== project.data.source_lang ||
          input.target_lang !== project.data.target_lang;
        await mutate<CloudProject>(id, who, (p) => ({
          ...p,
          source_lang: input.source_lang,
          target_lang: input.target_lang,
          direction: ["rtl", "ltr", "vertical"].includes(input.direction)
            ? input.direction
            : p.direction,
          quality: ["fast", "balanced", "quality"].includes(input.quality)
            ? input.quality
            : p.quality,
          style: ["natural", "literal", "faithful", "concise"].includes(
            input.style,
          )
            ? input.style
            : p.style,
          cancelled: false,
        }));
        for (const item of pages)
          await mutate<CloudPage>(item.id, who, (p) => {
            if (changed) p.regions = [];
            delete p.metrics.ocr_language;
            if (input.order) p.position = input.order.indexOf(p.id);
            return configureBubbles(
              p,
              input.direction || project.data.direction,
            );
          });
        return json(
          await projectDto(await document<CloudProject>(id, who), who),
        );
      }
      if (parts[2] === "cancel" && method === "POST") {
        await mutate<CloudProject>(id, who, (p) => ({ ...p, cancelled: true }));
        for (const p of await list<CloudPage>(who, "page", id))
          await mutate<CloudPage>(p.id, who, (page) => {
            if (["queued", "processing", "rendering"].includes(page.status)) {
              page.status = "paused";
              page.lease = undefined;
            }
            return page;
          });
        return json({ ok: true });
      }
      if (parts[2] === "claim" && method === "POST") {
        if (project.data.cancelled) return json(null);
        const pages = (await list<CloudPage>(who, "page", id)).sort(
          (a, b) => a.data.position - b.data.position,
        );
        for (const item of pages) {
          if (
            !["queued", "rendering", "processing"].includes(item.data.status) ||
            (item.data.lease && item.data.lease.until > Date.now())
          )
            continue;
          try {
            requireReview(item.data);
            const claimed = await mutate<CloudPage>(
              item.id,
              who,
              (p) => {
                if (p.lease && p.lease.until > Date.now())
                  fail(409, "This page is already processing.");
                p.lease = {
                  token: randomUUID(),
                  until: Date.now() + L.leaseMs,
                };
                p.status = "processing";
                return p;
              },
              item.version,
            );
            return json({
              page: claimed.data,
              project: project.data,
              token: claimed.data.lease!.token,
            });
          } catch (e) {
            if (!(e instanceof HttpError && e.status === 409)) throw e;
          }
        }
        return json(null);
      }
      if (parts[2] === "progress" && method === "PUT") {
        const input = await body(req);
        const count = (await list(who, "page", id)).length;
        await mutate<CloudProject>(id, who, (p) => ({
          ...p,
          last_page: integer(input.page, 0, Math.max(0, count - 1)),
        }));
        return json({ ok: true });
      }
      if (parts[2] === "glossary") {
        if (method === "GET") return json(project.data.glossary);
        if (method === "PUT") {
          const input = await body(req);
          if (!Array.isArray(input) || input.length > 100)
            fail(400, "Use up to 100 glossary entries.");
          const entries = input.map((v: Record<string, unknown>) => ({
            source: text(v.source, 200),
            target: text(v.target, 200),
          }));
          await mutate<CloudProject>(id, who, (p) => ({
            ...p,
            glossary: entries,
          }));
          return json(entries);
        }
      }
      if (parts[2] === "metadata" && method === "GET") {
        const data = {
          project: project.data,
          pages: (await list<CloudPage>(who, "page", id)).map((d) => ({
            ...d.data,
            assets: undefined,
            lease: undefined,
            garbage: undefined,
          })),
        };
        return new Response(JSON.stringify(data, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition":
              "attachment; filename=mangalens-project.json",
            "Cache-Control": "private, no-store",
          },
        });
      }
    }
    if (parts[0] === "pages" && parts[1]) {
      const pageDoc = await document<CloudPage>(parts[1], who, "page");
      const page = pageDoc.data;
      const project = await document<CloudProject>(
        page.project_id,
        who,
        "project",
      );
      if (parts[2] === "bubbles") {
        if (method === "GET")
          return json(page.bubble_scan || { status: "unscanned", bubbles: [] });
        if (method === "PUT") {
          if (["queued", "processing", "rendering"].includes(page.status))
            fail(409, "Pause processing before editing speech bubbles.");
          const scan = saveReview(page, await body(req));
          await mutate<CloudPage>(
            page.id,
            who,
            (current) => ({ ...current, bubble_scan: scan }),
            pageDoc.version,
          );
          return json(scan);
        }
      }
      if (parts[2] === "image" && method === "GET") {
        const kind = parts[3];
        if (
          !["original", "thumbnail", "translated", "clean", "mask"].includes(
            kind,
          )
        )
          fail(404, "Image not found.");
        const path = page.assets[kind];
        if (!path) fail(404, "This image has not been generated yet.");
        return NextResponse.redirect(await signed(path), {
          status: 307,
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      if (parts[2] === "uploaded" && method === "POST") {
        await verifyPng(page.assets.original, page.width, page.height);
        const thumbWidth = Math.min(256, page.width);
        const thumb = await verifyPng(
          page.assets.thumbnail,
          thumbWidth,
          Math.max(1, Math.round((page.height * thumbWidth) / page.width)),
        );
        if (!thumb.size || thumb.size > 500000)
          fail(400, "The page thumbnail is invalid or too large.");
        await mutate<CloudPage>(page.id, who, (p) => ({
          ...p,
          uploaded: true,
          status: "imported",
        }));
        return json({ ok: true });
      }
      if (parts[2] === "regions") {
        if (method === "GET")
          return json(
            page.regions.map((r) => ({
              ...r,
              render: { ...r.render, page_version: pageDoc.version },
            })),
          );
        if (method === "POST")
          fail(409, "Outline and confirm a speech bubble in the preview.");
      }
      if (["retry", "ocr", "rebuild"].includes(parts[2]) && method === "POST") {
        requireReview(page);
        const options = parts[2] === "ocr" ? await body(req) : {};
        if (
          options.source_lang &&
          !["auto", "ja", "en", "ko", "zh-CN", "zh-TW", "ru"].includes(
            options.source_lang,
          )
        )
          fail(400, "Choose a supported OCR language.");
        await mutate<CloudPage>(
          page.id,
          who,
          (p) => {
            if (options.source_lang)
              p.metrics.ocr_language = options.source_lang;
            if (
              parts[2] === "retry" &&
              !req.nextUrl.searchParams.has("changed_only")
            )
              p.regions = p.regions.filter((r) => r.source_text || r.restored);
            if (parts[2] === "rebuild")
              p.regions = p.regions.filter(r => r.source_text || r.translation || r.restored);
            return configureBubbles(
              p,
              project.data.direction,
              parts[2] === "ocr",
            );
          },
          pageDoc.version,
        );
        await mutate<CloudProject>(project.id, who, (p) => ({
          ...p,
          cancelled: false,
        }));
        return json({ ok: true });
      }
      const input = method === "POST" ? await body(req) : {};
      if (
        [
          "recognize",
          "prepare",
          "translate",
          "output-urls",
          "commit",
          "failed",
        ].includes(parts[2])
      ) {
        lease(page, input.token);
        requireReview(page);
        if (project.data.cancelled) fail(409, "This chapter was paused.");
        if (parts[2] === "recognize" && method === "POST") {
          requireReview(page);
          const requested = input.indices ?? [input.index];
          if (!Array.isArray(requested) || !requested.length || requested.length > L.ocrBatch)
            fail(400, "Select a valid group of bubbles.");
          const indices = [...new Set<number>(requested.map((index: unknown) => integer(index, 0, page.tile_count - 1)))]
            .filter(index => !page.tiles_done.includes(index));
          if (!indices.length) return json({ ok: true });
          const ids = page.metrics.bubble_order as string[];
          const selections = approved(page.bubble_scan);
          let retryAt = Math.max(Number(page.metrics.ocr_retry_at || 0), project.data.ocr_retry_at || 0);
          const original = retryAt > Date.now() ? undefined : await readOcrPage(page);
          const crops = await Promise.all(indices.map(async index => {
            const bubble = selections.find(item => item.id === ids?.[index]);
            if (!bubble) return fail(409, "Approved bubble selection changed.");
            if (!original) return { index, bubble, tile: null, error: OCR_DEFERRED };
            try {
              const tile = await maskedTile(page, bubble, index, original);
              return { index, bubble, tile, error: tile ? "" : BOUNDARY };
            } catch (cause) {
              if (!(cause instanceof HttpError && cause.status === 422)) throw cause;
              return { index, bubble, tile: null, error: cause.message };
            }
          }));
          await mutate<CloudPage>(page.id, who, p => {
            lease(p, input.token);
            const attempts = Number(p.metrics.ocr_requests || 0) + crops.filter(crop => crop.tile).length;
            if (attempts > L.maxTiles) fail(429, "This page reached its OCR request budget.");
            p.metrics.ocr_requests = attempts;
            p.lease!.until = Date.now() + L.leaseMs;
            return p;
          }, pageDoc.version);
          let skipped = 0;
          for (const { index, bubble, tile, error: cropError } of crops) {
            let error = cropError;
            const crossing = !tile && error === BOUNDARY;
            let detected: Region[] = [];
            if (tile && retryAt > Date.now()) {
              error = OCR_DEFERRED;
              skipped++;
            } else if (tile) {
              try {
                detected = await recognize(tile, who, page, project.data);
                const outline = polygonRows(bubble.polygon);
                const outside = detected.some(({ box: [x, y, w, h] }) =>
                  !outline.contains(Math.floor(x + w / 2), Math.floor(y + h / 2)),
                );
                if (outside || !detected.length) {
                  error = outside
                    ? "OCR returned lettering beyond the selection. Check the bubble boundary."
                    : "OCR could not read the lettering. Retry OCR or verify a transcription.";
                  detected = [];
                }
              } catch (cause) {
                if (cause instanceof HttpError && cause.status === 429) {
                  retryAt = cause instanceof OCRRateLimitError ? cause.retryAt : Date.now() + 60_000;
                  await mutate<CloudProject>(project.id, who, p => ({
                    ...p, ocr_retry_at: Math.max(p.ocr_retry_at || 0, retryAt),
                  }));
                  error = OCR_DEFERRED;
                } else {
                  error = cause instanceof HttpError ? cause.message : "OCR failed for this bubble. Retry OCR.";
                }
              }
            }
            const words = ordered(detected);
            const frame = polygonBox(bubble.polygon);
            const region: Region = {
              id: randomUUID(),
              page_id: page.id,
              box: frame,
              kind: "speech_bubble",
              language: String(
                page.metrics.ocr_language || project.data.source_lang,
              ),
              orientation: words.some((r) => r.orientation === "vertical")
                ? "vertical"
                : "horizontal",
              source_text: words.map((r) => r.source_text).join("\n"),
              translation: "",
              confidence: 0,
              restored: false,
              render: {
                speech_bubble: frame,
                cleanup_box: frame,
                bubble_id: bubble.id,
                bubble_version: BUBBLE_VERSION,
                bubble_polygon: bubble.polygon,
                boundary_crossing: crossing,
                source_box: words.length ? union(words.map((r) => r.box)) : frame,
                words: words.flatMap(
                  (r) => (r.render.words as number[][]) || [r.box],
                ),
                diagnostic_status: crossing
                  ? "NEEDS_MANUAL_REVIEW"
                  : error
                    ? "OCR_FAILED"
                    : "OCR_SUCCESS",
                failure_reason: error,
              },
              warnings: error ? [error] : [],
            };
            await mutate<CloudPage>(page.id, who, p => {
              lease(p, input.token);
              if (!p.tiles_done.includes(index)) {
                p.tiles_done.push(index);
                p.regions.push(region);
              }
              if (retryAt > Date.now()) p.metrics.ocr_retry_at = retryAt;
              p.lease!.until = Date.now() + L.leaseMs;
              return p;
            });
          }
          if (skipped) await mutate<CloudPage>(page.id, who, p => {
            lease(p, input.token);
            p.metrics.ocr_requests = Number(p.metrics.ocr_requests) - skipped;
            return p;
          });
          return json({ ok: true });
        }
        if (parts[2] === "prepare")
          return fail(409, "Refresh to use the approved bubble layout.");
        if (parts[2] === "translate" && method === "POST") {
          requireReview(page);
          if (!page.translated && page.tiles_done.length !== page.tile_count)
            fail(409, "Finish bubble OCR before translating.");
          const order = page.metrics.bubble_order as string[];
          const regions = page.regions
            .filter((r) => validRegion(page, r))
            .sort(
              (a, b) =>
                order.indexOf(String(a.render.bubble_id)) -
                order.indexOf(String(b.render.bubble_id)),
            );
          const pending = regions.filter(r =>
            !page.translated && !r.translation && r.source_text && !r.render.boundary_crossing && !r.restored,
          );
          const results = new Map<string, Region>();
          if (pending.length) {
            try {
              const batch = await translate(pending, who, {
                ...project.data,
                source_lang: String(page.metrics.ocr_language || project.data.source_lang),
              }, regions.filter(r => !r.render.boundary_crossing).map(r => r.source_text).join("\n"));
              for (const region of batch) results.set(region.id, region);
            } catch (cause) {
              const reason = cause instanceof HttpError ? cause.message : "Translation failed for these bubbles.";
              for (const region of pending) results.set(region.id, {
                ...region,
                render: { ...region.render, diagnostic_status: "TRANSLATION_FAILED", failure_reason: reason },
                warnings: [...region.warnings, reason],
              });
            }
          }
          const translated = regions.map(region => results.get(region.id) || region);
          const saved = await mutate<CloudPage>(page.id, who, (p) => {
            lease(p, input.token);
            p.regions = translated;
            p.translated = true;
            p.lease!.until = Date.now() + L.leaseMs;
            return p;
          });
          return json({ regions: translated, version: saved.version });
        }
        if (parts[2] === "output-urls" && method === "POST") {
          const urls: Record<string, string> = {};
          const pending = ["translated", "clean", "mask"].map((kind) =>
            pathFor(who, page.id, kind, page.lease!.token),
          );
          await mutate<CloudPage>(page.id, who, (p) => {
            lease(p, input.token);
            p.garbage = Array.from(new Set([...p.garbage, ...pending]));
            return p;
          });
          await Promise.all(["translated", "clean", "mask"].map(async kind => {
            urls[kind] = await signed(pathFor(who, page.id, kind, page.lease!.token), true);
          }));
          return json(urls);
        }
        if (parts[2] === "commit" && method === "POST") {
          if (!page.translated)
            fail(
              409,
              "Translate the recognized text before saving the result.",
            );
          const assets: Record<string, string> = {};
          for (const kind of ["translated", "clean", "mask"]) {
            assets[kind] = pathFor(who, page.id, kind, page.lease!.token);
          }
          await Promise.all(Object.values(assets).map(path => verifyPng(path, page.width, page.height)));
          await verifyApprovedPixels(page, assets);
          const warnings = Array.isArray(input.warnings)
            ? input.warnings.map((s: unknown) => text(s, 300)).slice(0, 200)
            : [];
          const diagnosticInput = Array.isArray(input.diagnostics)
            ? input.diagnostics
            : [];
          const diagnostics = new Map<
            string,
            {
              status: string;
              reason: string;
              mask_pixels: number;
              font_size: number;
              layout_debug: LayoutDebug;
            }
          >();
          for (const value of diagnosticInput) {
            if (
              !value ||
              !page.regions.some((r) => r.id === value.id) ||
              diagnostics.has(value.id)
            )
              fail(400, "Invalid rendering diagnostics.");
            if (
              !["PRESERVED", "RESTORED", "RENDERED_NEEDS_REVIEW"].includes(
                value.status,
              )
            )
              fail(400, "Invalid rendering result.");
            const layoutDebug: LayoutDebug = {};
            for (const key of ["source", "placement", "rejected"] as const) {
              const runs = value.layout_debug?.[key];
              if (!Array.isArray(runs)) continue;
              layoutDebug[key] = runs.slice(0, 400).map(run => {
                if (!Array.isArray(run) || run.length !== 3)
                  fail(400, "Invalid diagnostic pixels.");
                const x = integer(run[0], 0, page.width - 1);
                return [x, integer(run[1], 0, page.height - 1),
                  integer(run[2], 1, page.width - x)];
              });
              layoutDebug[`${key}_truncated`] = value.layout_debug[`${key}_truncated`] === true;
            }
            diagnostics.set(value.id, {
              status: value.status,
              reason: text(value.reason, 300),
              mask_pixels: integer(
                value.mask_pixels,
                0,
                page.width * page.height,
              ),
              font_size: Number(value.font_size) || 0,
              layout_debug: layoutDebug,
            });
          }
          await mutate<CloudPage>(page.id, who, (p) => {
            lease(p, input.token);
            for (const r of p.regions) {
              const diagnostic = diagnostics.get(r.id);
              if (!diagnostic) continue;
              r.render = {
                ...r.render,
                diagnostic_status: diagnostic.reason === BOUNDARY ? "NEEDS_MANUAL_REVIEW"
                  : diagnostic.reason === CLEANUP ? "INPAINTING_FAILED"
                  : diagnostic.reason === TOO_LONG ? "RENDERING_FAILED"
                  : diagnostic.status === "PRESERVED" &&
                  [
                    "OCR_FAILED",
                    "TRANSLATION_FAILED",
                    "NEEDS_MANUAL_REVIEW",
                  ].includes(String(r.render.diagnostic_status))
                    ? r.render.diagnostic_status
                    : diagnostic.status,
                mask_status: diagnostic.mask_pixels ? "APPLIED" : "PRESERVED",
                mask_applied_pixels: diagnostic.mask_pixels,
                actual_font_size: diagnostic.font_size,
                failure_reason: diagnostic.reason,
                mask_failure_reason: diagnostic.reason === CLEANUP ? diagnostic.reason : "",
                layout_debug: diagnostic.layout_debug,
              };
            }
            const old = ["translated", "clean", "mask"].flatMap((k) =>
              p.assets[k] ? [p.assets[k]] : [],
            );
            p.garbage = [...p.garbage, ...old].filter(
              (path) => !Object.values(assets).includes(path),
            );
            p.assets = { ...p.assets, ...assets };
            p.lease = undefined;
            p.revision++;
            const pending = p.bubble_scan!.bubbles.filter(
              (item) => item.decision === "pending",
            ).length;
            const unresolved = p.regions.filter(
              (r) =>
                !r.restored &&
                (!r.render.source_verified || !r.render.actual_font_size),
            ).length;
            p.status = !p.bubble_scan!.bubbles.length
              ? "no_speech_bubbles"
              : !approved(p.bubble_scan).length
                ? "no_bubbles_selected"
                : pending || unresolved
                  ? "needs_review"
                  : "completed";
            const deferred = p.regions.filter(r => r.render.failure_reason === OCR_DEFERRED).length;
            const remaining = Math.ceil((Number(p.metrics.ocr_retry_at || 0) - Date.now()) / 60_000);
            const retryNotice = remaining > 0
              ? `Rebuild page translation in about ${remaining} min.` : "Use Rebuild page translation to retry.";
            const otherWarnings = [...warnings, ...p.regions.flatMap(r =>
              !diagnostics.has(r.id) && r.render.failure_reason
                ? ["Region " + (p.regions.indexOf(r) + 1) + ": " + r.render.failure_reason]
                : [],
            )].filter(warning => !warning.endsWith(OCR_DEFERRED));
            p.error = [...new Set([...otherWarnings,
              ...(deferred ? [`OCR paused for ${deferred} ${deferred === 1 ? "bubble" : "bubbles"}. ${retryNotice}`] : []),
            ])].join(" ");
            p.metrics = {
              ...p.metrics,
              completion:
                pending || unresolved ? "PARTIALLY_COMPLETED" : "COMPLETED",
              regions: p.regions.length,
              translated_regions: p.regions.filter((r) => r.translation).length,
              unresolved_regions: pending + unresolved,
              completed_regions: p.regions.length - unresolved,
              processing_mode: "browser",
              rendered_regions: p.regions.filter(r => r.render.actual_font_size).length,
              preserved_regions: p.regions.filter(r => !r.restored && !r.render.actual_font_size).length,
            };
            delete p.metrics.render_region_id;
            return p;
          });
          const garbage = Array.from(
            new Set([
              ...page.garbage,
              ...["translated", "clean", "mask"].flatMap((k) =>
                page.assets[k] ? [page.assets[k]] : [],
              ),
            ]),
          ).filter((path) => !Object.values(assets).includes(path));
          if (garbage.length) {
            try {
              await gateway({ op: "remove", paths: garbage.slice(0, 100) });
              await mutate<CloudPage>(page.id, who, (p) => ({
                ...p,
                garbage: p.garbage.filter((path) => !garbage.includes(path)),
              }));
            } catch {
              /* Retain garbage paths for retention/deletion cleanup. */
            }
          }
          return json({ ok: true });
        }
        if (parts[2] === "failed" && method === "POST") {
          await mutate<CloudPage>(page.id, who, (p) => {
            lease(p, input.token);
            p.status = "failed";
            p.error = text(
              input.message || "Processing stopped. Resume this page.",
              600,
            );
            p.lease = undefined;
            return p;
          });
          return json({ ok: true });
        }
      }
    }
    if (parts[0] === "regions" && parts[1]) {
      const pageDoc = await findRegion(parts[1], who);
      const page = pageDoc.data;
      const region = page.regions.find((r) => r.id === parts[1])!;
      const project = await document<CloudProject>(
        page.project_id,
        who,
        "project",
      );
      if (!validRegion(page, region))
        fail(409, "Open the bubble preview to approve this region first.");
      if (parts[2] === "ocr" && method === "POST") {
        await mutate<CloudPage>(
          page.id,
          who,
          (p) => {
            p.regions = p.regions.filter((r) => r.id !== region.id);
            return configureBubbles(p, project.data.direction);
          },
          pageDoc.version,
        );
        await mutate<CloudProject>(project.id, who, (p) => ({
          ...p,
          cancelled: false,
        }));
        return json({ queued: true });
      }
      if (method === "PUT" && parts.length === 2) {
        const input = await body(req);
        if (page.lease && page.lease.until > Date.now())
          fail(409, "Pause processing before editing this page.");
        const version = integer(input.page_version, 1, Number.MAX_SAFE_INTEGER);
        await mutate<CloudPage>(
          page.id,
          who,
          (p) => {
            const r = p.regions.find((r) => r.id === region.id)!;
            const translation = text(input.translation, 6000);
            const manualLineBreaks = translation !== r.translation
              ? translation.includes("\n")
              : r.render.manual_line_breaks ?? (r.render.user_edited && translation.includes("\n"));
            r.source_text = text(input.source_text, 3000);
            r.translation = translation;
            r.language = text(input.language, 16);
            r.box = box(input.box, p);
            r.restored = Boolean(input.restored);
            const rectangles = (value: unknown) =>
              Array.isArray(value)
                ? value.slice(0, 30).map((b) => box(b, p))
                : [];
            r.render = {
              ...r.render,
              user_edited: true,
              manual_line_breaks: Boolean(manualLineBreaks),
              mask_dilation: integer(input.mask_dilation ?? 1, 0, 4),
              font_size: integer(input.font_size, 12, 200),
              align: ["left", "center", "right"].includes(input.align)
                ? input.align
                : "center",
              offset_x: integer(input.offset_x, -12000, 12000),
              offset_y: integer(input.offset_y, -12000, 12000),
              source_box: box(input.source_box, p),
              mask_include: rectangles(input.mask_include),
              mask_exclude: rectangles(input.mask_exclude),
              source_verified: Boolean(input.source_verified),
            };
            p.metrics = { ...p.metrics, render_region_id:
              p.status === "rendering" && p.metrics.render_region_id !== r.id
                ? undefined : r.id };
            p.translated = true;
            p.status = "rendering";
            p.lease = undefined;
            return p;
          },
          version,
        );
        await mutate<CloudProject>(project.id, who, (p) => ({
          ...p,
          cancelled: false,
        }));
        return json(region);
      }
      if (parts[2] === "retry" && method === "POST" && ["mask", "clean", "render"].includes(parts[3])) {
        if (page.lease && page.lease.until > Date.now())
          fail(409, "Pause processing before retrying this region.");
        if (!page.translated || !region.translation.trim() || region.restored)
          fail(409, "Save a translation for this bubble before retrying.");
        await mutate<CloudPage>(page.id, who, p => ({
          ...p,
          status: "rendering",
          lease: undefined,
          metrics: { ...p.metrics, render_region_id:
            p.status === "rendering" && p.metrics.render_region_id !== region.id
              ? undefined : region.id },
        }), pageDoc.version);
        await mutate<CloudProject>(project.id, who, p => ({...p, cancelled: false}));
        return json({ queued: true });
      }
      if (parts[2] === "retranslate" && method === "POST") {
        if (region.render.boundary_crossing || !region.source_text.trim())
          fail(422, "Verify the bubble and source text first.");
        if (page.lease && page.lease.until > Date.now())
          fail(409, "Pause processing before retranslating this region.");
        const result = await translate(
          [{ ...region, translation: "", render: { ...region.render, manual_line_breaks: false } }],
          who,
          project.data,
        );
        await mutate<CloudPage>(
          page.id,
          who,
          (p) => ({
            ...p,
            regions: p.regions.map((r) => (r.id === region.id ? result[0] : r)),
            status: "rendering",
            translated: true,
            lease: undefined,
            metrics: { ...p.metrics, render_region_id:
              p.status === "rendering" && p.metrics.render_region_id !== region.id
                ? undefined : region.id },
          }),
          pageDoc.version,
        );
        await mutate<CloudProject>(project.id, who, (p) => ({
          ...p,
          cancelled: false,
        }));
        return json(result[0]);
      }
      if (parts[2] === "feedback" && method === "POST") {
        const input = await body(req);
        text(input.category, 40);
        await mutate<CloudPage>(page.id, who, (p) => {
          p.regions.find((r) => r.id === region.id)!.render.feedback =
            input.category;
          return p;
        });
        return json({ ok: true });
      }
      if (parts[2] === "mask-candidate" && method === "GET")
        fail(
          409,
          "Mask candidates are not available in browser mode. Use the saved mask view.",
        );
      if (parts[2] === "ocr" || parts[2] === "retry")
        fail(
          409,
          "Use Retry page to resume cloud recognition. Saved region text can be edited manually.",
        );
    }
    if (route === "/usage" && method === "GET") {
      const month = new Date();
      month.setUTCDate(1);
      month.setUTCHours(0, 0, 0, 0);
      const events = await db<{
        kind: string;
        amount: number;
        engine: number;
        created_at: string;
        owner: string;
      }>("ml_usage", "GET", {
        created_at: "gte." + month.toISOString(),
        limit: "20000",
      });
      const own = events.filter((e) => e.owner === who),
        deepl = own.filter((e) => e.kind === "deepl"),
        ocr = events.filter((e) => e.kind === "ocr");
      return json({
        providers: {},
        deepl: {
          characters_submitted: deepl.reduce((n, e) => n + e.amount, 0),
          local_characters_committed: events
            .filter((e) => e.kind === "deepl")
            .reduce((n, e) => n + e.amount, 0),
          requests: deepl.length,
          failures: 0,
          rate_limits: 0,
          local_monthly_budget: 100000,
          account_error:
            "Account usage is available from DeepL; local reservations include uncertain requests.",
        },
        cloud_ocr: { requests: 0, failures: 0, local_monthly_budget: 0 },
        ocr_space: {
          requests_today: ocr.filter(
            (e) =>
              e.created_at.slice(0, 10) ===
              new Date().toISOString().slice(0, 10),
          ).length,
          requests_month: ocr.length,
          engine_2_requests: ocr.filter((e) => e.engine === 2).length,
          engine_3_requests: ocr.filter((e) => e.engine === 3).length,
          failures: 0,
          rate_limits: 0,
          daily_budget: 50,
          monthly_budget: 400,
          engine_3_monthly_budget: 300,
        },
      });
    }
    return json(
      { detail: "This action is unavailable in the browser processing mode." },
      404,
    );
  } catch (error) {
    if (error instanceof HttpError)
      return json({ detail: error.message }, error.status);
    console.error(
      "MangaLens cloud request failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return json(
      {
        detail:
          "The request could not finish. Retry shortly; saved pages are preserved.",
      },
      502,
    );
  }
}
export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
