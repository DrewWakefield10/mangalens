import { prepareRegions, type LayoutGroup } from "@/lib/page-layout";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { Region } from "@/lib/api";
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
import {
  overlap,
  recognize,
  translate,
  type Tile,
} from "@/lib/cloud-providers";
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
            // Resume completed work unless preferences changed. Explicit per-page retry reprocesses it.
            if (changed) {
              p.regions = [];
              p.tiles_done = [];
              p.tile_count = 0;
              p.translated = false;
            }
            if (!["completed", "needs_review"].includes(p.status) || changed) {
              p.status = "queued";
              p.error = "";
              p.lease = undefined;
            }
            if (input.order) p.position = input.order.indexOf(p.id);
            return p;
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
        if (method === "POST") {
          const input = await body(req);
          if (page.lease && page.lease.until > Date.now())
            fail(409, "Pause processing before adding a region.");
          if (page.regions.length >= L.maxRegions)
            fail(400, "This page already has 200 regions.");
          const region: Region = {
            id: randomUUID(),
            page_id: page.id,
            box: box(input.box, page),
            source_text: "",
            translation: "",
            language: text(input.language || project.data.source_lang, 16),
            confidence: 0,
            orientation: "horizontal",
            kind: "manual",
            render: { source_verified: false },
            warnings: [],
            restored: false,
          };
          // Manual region creation preserves all existing source corrections.
          await mutate<CloudPage>(page.id, who, (p) => ({
            ...p,
            regions: [...p.regions, region],
            metrics: { ...p.metrics, layout_version: 0 },
            status: "needs_review",
          }));
          return json(region, 201);
        }
      }
      if (["retry", "ocr", "rebuild"].includes(parts[2]) && method === "POST") {
        const options = parts[2] === "ocr" ? await body(req) : {};
        const recoverySource = options.source_lang || project.data.source_lang;
        if (
          parts[2] === "ocr" &&
          !["auto", "ja", "en", "ko", "zh-CN", "zh-TW", "ru"].includes(
            recoverySource,
          )
        )
          fail(400, "Choose a supported OCR language.");
        await mutate<CloudProject>(project.id, who, (p) => ({
          ...p,
          cancelled: false,
        }));
        await mutate<CloudPage>(page.id, who, (p) => {
          if (p.lease && p.lease.until > Date.now())
            fail(
              409,
              "Wait for this page to finish or pause the chapter first.",
            );
          if (parts[2] === "ocr") {
            p.metrics.ocr_language = recoverySource;
            p.regions = p.regions.filter(
              (r) =>
                r.kind === "manual" ||
                r.restored ||
                r.render.user_edited ||
                r.render.source_verified,
            );
            p.tiles_done = [];
            p.tile_count = 0;
            p.translated = false;
            p.metrics.layout_version = 0;
          }
          if (parts[2] === "rebuild") {
            p.metrics.layout_version = 0;
            p.translated = false;
          }
          // Resume retains checkpoints; an explicit OCR retry preserves manual corrections.
          p.status = "queued";
          p.error = "";
          p.lease = undefined;
          return p;
        });
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
        if (project.data.cancelled) fail(409, "This chapter was paused.");
        if (parts[2] === "recognize" && method === "POST") {
          const tile = input.tile as Tile;
          if (
            !tile ||
            typeof tile.base64 !== "string" ||
            tile.base64.length > 1_340_000 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(tile.base64)
          )
            fail(400, "Invalid OCR image tile.");
          integer(tile.count, 1, L.maxTiles);
          integer(tile.index, 0, tile.count - 1);
          integer(tile.x, 0, page.width - 1);
          integer(tile.y, 0, page.height - 1);
          integer(tile.width, 1, page.width - tile.x);
          integer(tile.height, 1, page.height - tile.y);
          if (page.tile_count && page.tile_count !== tile.count)
            fail(409, "OCR tiling changed. Retry with the saved page.");
          if (page.tiles_done.includes(tile.index)) return json({ ok: true });
          await mutate<CloudPage>(page.id, who, (p) => {
            lease(p, input.token);
            const attempts = Number(p.metrics.ocr_requests || 0);
            if (attempts >= L.maxTiles)
              fail(
                429,
                "This page reached its 12-attempt OCR budget. Edit missing text manually.",
              );
            p.metrics.ocr_requests = attempts + 1;
            return p;
          });
          const regions = await recognize(tile, who, page, project.data);
          await mutate<CloudPage>(page.id, who, (p) => {
            lease(p, input.token);
            if (!p.tiles_done.includes(tile.index)) {
              for (const r of regions)
                if (
                  !p.regions.some(
                    (old) =>
                      overlap(
                        (old.render.source_box as number[]) || old.box,
                        r.box,
                      ) > 0.6 &&
                      (old.source_text === r.source_text ||
                        old.render.user_edited === true ||
                        old.kind === "manual"),
                  )
                )
                  p.regions.push(r);
              p.regions = p.regions.slice(0, L.maxRegions);
              p.tiles_done.push(tile.index);
              p.tile_count = tile.count;
            }
            p.lease!.until = Date.now() + L.leaseMs;
            p.metrics = {
              ...p.metrics,
              recognized_regions: p.regions.length,
              regions_detected: p.regions.length,
            };
            return p;
          });
          return json({ ok: true });
        }
        if (parts[2] === "prepare" && method === "POST") {
          if (
            !Array.isArray(input.groups) ||
            input.groups.length > L.maxRegions
          )
            fail(400, "Invalid text grouping.");
          const seen = new Set<string>();
          const groups: LayoutGroup[] = input.groups.map((g: LayoutGroup) => {
            if (
              !g ||
              !Array.isArray(g.ids) ||
              !g.ids.length ||
              new Set(g.ids).size !== g.ids.length ||
              g.ids.some(
                (id) =>
                  typeof id !== "string" ||
                  seen.has(id) ||
                  !page.regions.some((r) => r.id === id),
              )
            )
              fail(400, "Each text region must be grouped once.");
            g.ids.forEach((id) => seen.add(id));
            const members = g.ids.map((id) =>
              page.regions.find((r) => r.id === id)!,
            );
            if (
              members.some(
                (r) =>
                  r.kind === "manual" ||
                  r.restored ||
                  r.render.user_edited ||
                  r.render.source_verified,
              ) &&
              g.ids.length !== 1
            )
              fail(400, "Saved corrections cannot be merged.");
            return {
              ids: g.ids,
              box: box(g.box, page),
              ...(g.bubble
                ? {
                    bubble: box(g.bubble, page),
                    cleanup: g.cleanup
                      ? box(g.cleanup, page)
                      : box(g.bubble, page),
                  }
                : {}),
            };
          });
          if (seen.size !== page.regions.length)
            fail(400, "Text grouping omitted a region.");
          // Older saved pages retain the provider's paragraph order when rebuilt.
          const source = page.regions.map((r, i) => ({
            ...r,
            render: {
              ...r.render,
              ...(r.render.ocr_order === undefined
                ? { ocr_order: i, ocr_paragraph: "legacy" }
                : {}),
            },
          }));
          const prepared = prepareRegions(source, groups);
          await mutate<CloudPage>(
            page.id,
            who,
            (p) => {
              lease(p, input.token);
              p.regions = prepared;
              p.translated = false;
              p.metrics.layout_version = 2;
              p.lease!.until = Date.now() + L.leaseMs;
              return p;
            },
            pageDoc.version,
          );
          return json({ regions: prepared });
        }
        if (parts[2] === "translate" && method === "POST") {
          if (
            !page.translated &&
            (!page.tile_count || page.tiles_done.length !== page.tile_count) &&
            !(
              page.regions.length > 0 &&
              page.regions.every(
                (r) =>
                  r.kind === "manual" ||
                  r.restored ||
                  r.render.user_edited ||
                  r.render.source_verified,
              )
            )
          )
            fail(409, "Finish text recognition before translating.");
          const translated = page.translated
            ? page.regions
            : await translate(page.regions, who, {
                ...project.data,
                source_lang: String(
                  page.metrics.ocr_language || project.data.source_lang,
                ),
              });
          await mutate<CloudPage>(page.id, who, (p) => {
            lease(p, input.token);
            p.regions = translated;
            p.translated = true;
            p.lease!.until = Date.now() + L.leaseMs;
            return p;
          });
          return json({
            regions: translated,
            version: (await document(page.id, who)).version,
          });
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
          for (const kind of ["translated", "clean", "mask"])
            urls[kind] = await signed(
              pathFor(who, page.id, kind, page.lease!.token),
              true,
            );
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
            await verifyPng(assets[kind], page.width, page.height);
          }
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
            diagnostics.set(value.id, {
              status: value.status,
              reason: text(value.reason, 300),
              mask_pixels: integer(
                value.mask_pixels,
                0,
                page.width * page.height,
              ),
              font_size: Number(value.font_size) || 0,
            });
          }
          await mutate<CloudPage>(page.id, who, (p) => {
            lease(p, input.token);
            for (const r of p.regions) {
              const diagnostic = diagnostics.get(r.id);
              if (!diagnostic) continue;
              r.render = {
                ...r.render,
                diagnostic_status: diagnostic.status,
                mask_status: diagnostic.mask_pixels ? "APPLIED" : "PRESERVED",
                mask_applied_pixels: diagnostic.mask_pixels,
                actual_font_size: diagnostic.font_size,
                failure_reason: diagnostic.reason,
                mask_failure_reason:
                  diagnostic.status === "PRESERVED" ? diagnostic.reason : "",
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
            p.status = "needs_review";
            p.error = warnings.join(" ");
            p.metrics = {
              ...p.metrics,
              completion: "PARTIALLY_COMPLETED",
              regions: p.regions.length,
              translated_regions: p.regions.filter((r) => r.translation).length,
              unresolved_regions: p.regions.length,
              completed_regions: 0,
              processing_mode: "browser",
              rendered_regions: [...diagnostics.values()].filter(
                (d) => d.status === "RENDERED_NEEDS_REVIEW",
              ).length,
              preserved_regions: [...diagnostics.values()].filter(
                (d) => d.status === "PRESERVED",
              ).length,
            };
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
            r.source_text = text(input.source_text, 3000);
            r.translation = text(input.translation, 6000);
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
      if (parts[2] === "retranslate" && method === "POST") {
        if (page.lease && page.lease.until > Date.now())
          fail(409, "Pause processing before retranslating this region.");
        const result = await translate(
          [{ ...region, translation: "" }],
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
