import { randomUUID } from "node:crypto";
import type { Region } from "./api";
import type { CloudPage, CloudProject } from "./cloud-types";
import { fail, gateway } from "./cloud-store";
type OCRWord = {
  WordText?: string;
  Left: number;
  Top: number;
  Width: number;
  Height: number;
};
type OCRPayload = {
  OCRExitCode: number;
  IsErroredOnProcessing?: boolean;
  ParsedResults?: {
    FileParseExitCode: number;
    TextOverlay?: { Lines?: { LineText?: string; Words?: OCRWord[] }[] };
  }[];
};
export type Tile = {
  index: number;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
  base64: string;
};
export function overlap(a: number[], b: number[]) {
  return (
    (Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
      Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))) /
    Math.max(1, Math.min(a[2] * a[3], b[2] * b[3]))
  );
}
export function parseOcr(
  payload: OCRPayload,
  tile: Tile,
  pageId: string,
  source: string,
): Region[] {
  if (
    payload.IsErroredOnProcessing ||
    ![1, 2].includes(Number(payload.OCRExitCode))
  )
    return fail(
      422,
      "OCR.space could not recognize this image. Retry later or add text manually in the editor.",
    );
  const regions: Region[] = [];
  for (const result of payload.ParsedResults || []) {
    if (Number(result.FileParseExitCode) !== 1) continue;
    for (const line of result.TextOverlay?.Lines || []) {
      const words = (line.Words || []).flatMap((w) => {
        const values = [w.Left, w.Top, w.Width, w.Height].map(Number);
        if (!values.every(Number.isFinite)) return [];
        const x = Math.max(0, values[0]),
          y = Math.max(0, values[1]);
        const width = Math.min(tile.width, values[0] + values[2]) - x,
          height = Math.min(tile.height, values[1] + values[3]) - y;
        return width > 0 && height > 0
          ? [[x + tile.x, y + tile.y, width, height]]
          : [];
      });
      const text = String(
        line.LineText ||
          (line.Words || []).map((w) => w.WordText || "").join(" "),
      )
        .trim()
        .slice(0, 3000);
      if (!words.length || !text) continue;
      const x = Math.min(...words.map((w) => w[0])),
        y = Math.min(...words.map((w) => w[1]));
      const right = Math.max(...words.map((w) => w[0] + w[2])),
        bottom = Math.max(...words.map((w) => w[1] + w[3]));
      regions.push({
        id: randomUUID(),
        page_id: pageId,
        box: [x, y, right - x, bottom - y],
        source_text: text,
        translation: "",
        language: source,
        confidence: 0,
        orientation: "horizontal",
        kind: "cloud_text",
        render: {
          words,
          source_box: [x, y, right - x, bottom - y],
          source_verified: false,
          diagnostic_status: "NEEDS_REVIEW",
        },
        warnings: [
          "OCR.space supplies no confidence score. Review recognized text and placement.",
        ],
        restored: false,
      });
    }
  }
  return regions;
}
export async function recognize(
  tile: Tile,
  who: string,
  page: CloudPage,
  project: CloudProject,
) {
  if (!process.env.OCR_SPACE_API_KEY) fail(503, "OCR.space is not configured.");
  const source = project.source_lang;
  const engine = ["zh-CN", "zh-TW", "en", "ru"].includes(source) ? 2 : 3;
  await gateway({
    op: "rpc",
    name: "ml_reserve_budget",
    body: { p_owner: who, p_kind: "ocr", p_amount: 1, p_engine: engine },
  });
  const form = new FormData();
  form.append("base64Image", "data:image/jpeg;base64," + tile.base64);
  form.append(
    "language",
    (
      {
        ja: "jpn",
        ko: "kor",
        "zh-CN": "chs",
        "zh-TW": "cht",
        en: "eng",
        ru: "rus",
      } as Record<string, string>
    )[source] || "auto",
  );
  form.append("OCREngine", String(engine));
  form.append("isOverlayRequired", "true");
  form.append("scale", "true");
  let response: Response;
  try {
    response = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: process.env.OCR_SPACE_API_KEY! },
      body: form,
      signal: AbortSignal.timeout(75000),
    });
  } catch {
    return fail(
      504,
      "OCR.space timed out. Saved pages are preserved; retry this page later.",
    );
  }
  if (response.status === 429)
    fail(429, "OCR.space is rate-limiting requests. Retry later.");
  if (!response.ok)
    fail(
      502,
      "OCR.space could not process this page. Check the provider configuration or retry later.",
    );
  return parseOcr(await response.json(), tile, page.id, source);
}
const targetCodes: Record<string, string> = {
  en: "EN-US",
  "zh-CN": "ZH-HANS",
  "zh-TW": "ZH-HANT",
  tl: "TL",
};
export async function translate(
  regions: Region[],
  who: string,
  project: CloudProject,
) {
  if (!process.env.DEEPL_API_KEY) fail(503, "DeepL is not configured.");
  const pending = regions.filter(
    (r) => !r.translation && r.source_text.trim() && !r.restored,
  );
  const result = structuredClone(regions);
  // Exact glossary matches are deterministic and do not consume provider quota.
  for (const r of pending) {
    const term = project.glossary.find((g) => g.source === r.source_text);
    if (term) {
      result.find((v) => v.id === r.id)!.translation = term.target;
      r.translation = term.target;
    }
  }
  const items = pending.filter((r) => !r.translation);
  if (!items.length) return result;
  const texts = items.map((r) => r.source_text);
  if (texts.reduce((a, s) => a + s.length, 0) > 30000)
    fail(400, "This page exceeds the 30,000-character translation limit.");
  const key = process.env.DEEPL_API_KEY!;
  const base = key.endsWith(":fx")
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com";
  for (let offset = 0; offset < items.length; offset += 50) {
    const batch = items.slice(offset, offset + 50);
    await gateway({
      op: "rpc",
      name: "ml_reserve_budget",
      body: {
        p_owner: who,
        p_kind: "deepl",
        p_amount: batch.reduce(
          (n, r) => n + Array.from(r.source_text).length,
          0,
        ),
      },
    });
    const body: Record<string, unknown> = {
      text: batch.map((r) => r.source_text),
      target_lang:
        targetCodes[project.target_lang] || project.target_lang.toUpperCase(),
      context: texts.join("\n").slice(0, 12000),
      preserve_formatting: true,
    };
    if (project.source_lang !== "auto")
      body.source_lang = project.source_lang.split("-")[0].toUpperCase();
    if (project.source_lang === project.target_lang) {
      for (const r of batch)
        result.find((v) => v.id === r.id)!.translation = r.source_text;
      continue;
    }
    let response: Response;
    try {
      response = await fetch(base + "/v2/translate", {
        method: "POST",
        headers: {
          Authorization: "DeepL-Auth-Key " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
    } catch {
      return fail(
        504,
        "DeepL timed out. Retry translation later; recognized text is saved.",
      );
    }
    if (response.status === 456)
      fail(429, "Your DeepL account character quota is exhausted.");
    if (response.status === 429)
      fail(429, "DeepL is rate-limiting requests. Retry later.");
    if (!response.ok)
      fail(
        502,
        "DeepL could not translate this language pair. Check Settings or try a different pair.",
      );
    const data = (await response.json()) as {
      translations: { text: string; detected_source_language?: string }[];
    };
    if (
      data.translations?.length !== batch.length ||
      data.translations.some((r) => !r.text?.trim())
    )
      fail(
        502,
        "DeepL returned incomplete translations. Recognized text is saved; retry later.",
      );
    batch.forEach((r, i) => {
      const target = result.find((v) => v.id === r.id)!;
      target.translation = data.translations[i].text;
      target.language =
        data.translations[i].detected_source_language?.toLowerCase() ||
        target.language;
    });
  }
  return result;
}
