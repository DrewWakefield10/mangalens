import { speechMap, bubbleInk } from "./page-layout";
import type { Region } from "./api";
import type { CloudPage } from "./cloud-types";
import { blobOf, canvasOf } from "./browser-pages";
export type BrowserTile = {
  index: number;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
  base64: string;
};
export async function makeTiles(bitmap: ImageBitmap) {
  const tiles: Omit<BrowserTile, "count">[] = [];
  for (let y = 0; y < bitmap.height; y += 1400)
    for (let x = 0; x < bitmap.width; x += 1400) {
      const width = Math.min(1500, bitmap.width - x),
        height = Math.min(1500, bitmap.height - y);
      // Do not create a tiny redundant sliver already covered by the previous overlap.
      if ((x > 0 && width <= 100) || (y > 0 && height <= 100)) continue;
      const canvas = canvasOf(width, height);
      canvas
        .getContext("2d")!
        .drawImage(bitmap, x, y, width, height, 0, 0, width, height);
      let blob = await blobOf(canvas, "image/jpeg", 0.9);
      for (const quality of [0.8, 0.65, 0.5])
        if (blob.size > 990000)
          blob = await blobOf(canvas, "image/jpeg", quality);
      canvas.width = canvas.height = 0;
      if (blob.size > 990000)
        throw new Error(
          "This page needs smaller OCR tiles. Use a smaller image.",
        );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      tiles.push({
        index: tiles.length,
        x,
        y,
        width,
        height,
        base64: btoa(binary),
      });
      await new Promise((r) => setTimeout(r, 0));
    }
  if (tiles.length > 12)
    throw new Error(
      "This page exceeds the 12-tile OCR limit. Use a smaller image.",
    );
  return tiles.map((tile) => ({ ...tile, count: tiles.length }));
}
let font: Promise<void> | undefined;
function loadFont() {
  return (font ||= (async () => {
    const face = new FontFace(
      "MangaLensCJK",
      "url(/fonts/NotoSansCJKjp-Regular.otf)",
    );
    const loaded = await face.load();
    document.fonts.add(loaded);
    await document.fonts.ready;
  })().catch((error) => {
    font = undefined;
    throw new Error(
      "The typesetting font could not load. Check your connection and retry.",
    );
  }));
}
function bounded(box: number[], width: number, height: number) {
  const x = Math.max(0, Math.floor(box[0])),
    y = Math.max(0, Math.floor(box[1]));
  return [
    x,
    y,
    Math.max(0, Math.min(width - x, Math.ceil(box[2]))),
    Math.max(0, Math.min(height - y, Math.ceil(box[3]))),
  ];
}
function inside(x: number, y: number, b: number[]) {
  return x >= b[0] && y >= b[1] && x < b[0] + b[2] && y < b[1] + b[3];
}
function linesOf(ctx: CanvasRenderingContext2D, value: string, width: number) {
  const lines: string[] = [];
  let line = "";
  // Segment by words for Latin text, and by characters for CJK/long unbroken words.
  for (const paragraph of value.split("\n")) {
    const chunks = paragraph
      .split(/(\s+)/)
      .filter(Boolean)
      .flatMap((word) =>
        ctx.measureText(word).width > width && /[\u3000-\u9fff]/u.test(word)
          ? Array.from(word)
          : [word],
      );
    for (const chunk of chunks) {
      if (line && ctx.measureText(line + chunk).width > width) {
        lines.push(line.trim());
        line = chunk.trimStart();
      } else line += chunk;
    }
    lines.push(line.trim());
    line = "";
  }
  return lines;
}

export type RenderDiagnostic = {
  id: string;
  status: string;
  reason: string;
  mask_pixels: number;
  font_size: number;
};
type TextLine = { text: string; x: number; y: number; width: number };
function overlaps(a: number[], b: number[]) {
  return (
    a[0] < b[0] + b[2] &&
    a[0] + a[2] > b[0] &&
    a[1] < b[1] + b[3] &&
    a[1] + a[3] > b[1]
  );
}
function fitText(
  ctx: CanvasRenderingContext2D,
  region: Region,
  map: ReturnType<typeof speechMap>,
) {
  const destination = bounded(region.box, map.width, map.height),
    bubble = region.render.speech_bubble as number[] | undefined;
  const area =
    bubble && !region.render.user_edited
      ? [...map.areas.values()].find((a) =>
          a.box.every((v, i) => Math.abs(v - bubble[i]) < 2),
        )
      : undefined;
  const clip = (region.render.cleanup_box as number[]) || destination;
  const tokens = region.translation
    .trim()
    .split(/\s+/)
    .flatMap((word) =>
      /[\u3000-\u9fff]/u.test(word) ? Array.from(word) : [word],
    );
  const maxSize = Math.min(
    100,
    Number(region.render.font_size) ||
      Math.min(
        48,
        Math.sqrt(
          (destination[2] * destination[3]) /
            Math.max(1, region.translation.length),
        ) * 1.3,
      ),
  );
  for (let size = maxSize; size >= 12; size -= 0.5) {
    ctx.font = size + 'px "MangaLensCJK"';
    if (!area) {
      const lines = linesOf(
        ctx,
        region.translation,
        Math.max(1, destination[2] - 4),
      );
      if (
        lines.length * size * 1.2 <= destination[3] - 4 &&
        lines.every((l) => ctx.measureText(l).width <= destination[2] - 4)
      ) {
        const start =
          destination[1] +
          Math.max(2, (destination[3] - lines.length * size * 1.2) / 2);
        return {
          size,
          lines: lines.map((text, i) => ({
            text,
            x: destination[0] + 2,
            y: start + i * size * 1.2,
            width: destination[2] - 4,
          })),
        };
      }
      continue;
    }
    let best: { size: number; lines: TextLine[]; score: number } | undefined;
    const pad = Math.max(4, Math.round(Math.min(clip[2], clip[3]) * 0.045)),
      lineHeight = Math.ceil(size * 1.2);
    for (const fraction of [0, 0.08, 0.16, 0.24, 0.32]) {
      const lines: TextLine[] = [];
      let index = 0;
      for (
        let y = Math.round(clip[1] + pad + clip[3] * fraction);
        y + lineHeight <= clip[1] + clip[3] - pad && index < tokens.length;
        y += lineHeight
      ) {
        let left = clip[0] + pad,
          right = clip[0] + clip[2] - pad;
        for (let row = y; row < y + lineHeight; row++) {
          const yy = row - area.box[1];
          if (yy < 0 || yy >= area.left.length) {
            right = left;
            break;
          }
          left = Math.max(left, area.left[yy] + pad);
          right = Math.min(right, area.right[yy] - pad);
        }
        const width = right - left;
        if (width < size) continue;
        let line = "";
        while (index < tokens.length) {
          const next =
            line +
            (line && !/[\u3000-\u9fff]/u.test(tokens[index]) ? " " : "") +
            tokens[index];
          if (ctx.measureText(next).width > width) break;
          line = next;
          index++;
        }
        if (line) lines.push({ text: line, x: left, y, width });
      }
      if (index === tokens.length && lines.length) {
        const mid = (lines[0].y + lines[lines.length - 1].y + lineHeight) / 2;
        const score = Math.abs(mid - (clip[1] + clip[3] / 2));
        if (!best || score < best.score) best = { size, lines, score };
      }
    }
    if (best) return { size: best.size, lines: best.lines };
  }
}
export async function renderPage(
  bitmap: ImageBitmap,
  page: CloudPage,
  regions: Region[],
) {
  await loadFont();
  const width = bitmap.width,
    height = bitmap.height,
    clean = canvasOf(width, height),
    translated = canvasOf(width, height),
    mask = canvasOf(width, height);
  const cleanCtx = clean.getContext("2d", { willReadFrequently: true })!,
    target = translated.getContext("2d")!,
    maskCtx = mask.getContext("2d")!;
  cleanCtx.drawImage(bitmap, 0, 0);
  const original = cleanCtx.getImageData(0, 0, width, height),
    pixels = new Uint8ClampedArray(original.data),
    map = speechMap(original);
  const maskPixels = new Uint8Array(width * height),
    warnings: string[] = [],
    diagnostics: RenderDiagnostic[] = [];
  const protectedRegions = regions.filter(
    (r) =>
      r.restored ||
      r.render.user_edited ||
      r.kind === "manual" ||
      r.render.source_verified,
  );
  const drawable: {
    region: Region;
    layout: { size: number; lines: TextLine[] };
  }[] = [];
  for (const [index, region] of regions.entries()) {
    const diagnostic: RenderDiagnostic = {
      id: region.id,
      status: "PRESERVED",
      reason: "",
      mask_pixels: 0,
      font_size: 0,
    };
    diagnostics.push(diagnostic);
    const preserve = (reason: string) => {
      diagnostic.reason = reason;
      warnings.push("Region " + (index + 1) + ": " + reason);
    };
    if (region.restored) {
      diagnostic.status = "RESTORED";
      continue;
    }
    if (!region.translation.trim()) {
      preserve(
        "no translated text was available; original lettering was preserved.",
      );
      continue;
    }
    const source = bounded(
      (region.render.source_box as number[]) || region.box,
      width,
      height,
    );
    const excludes = [
        ...((region.render.mask_exclude as number[][]) || []),
        ...protectedRegions
          .filter((r) => r.id !== region.id)
          .flatMap((r) => [(r.render.source_box as number[]) || r.box, r.box]),
      ],
      includes = (region.render.mask_include as number[][]) || [];
    const bubble = region.render.speech_bubble as number[] | undefined,
      clip = (region.render.cleanup_box as number[]) || bubble;
    const ink: number[] = [];
    if (bubble && !includes.length) {
      for (const pixel of bubbleInk(original, map, bubble, clip))
        ink.push(pixel);
    } else {
      const [x, y, w, h] = source,
        margin = 5;
      let white = 0,
        count = 0,
        borderWhite = 0,
        border = 0,
        colored = 0;
      for (
        let yy = Math.max(0, y - margin);
        yy < Math.min(height, y + h + margin);
        yy++
      )
        for (
          let xx = Math.max(0, x - margin);
          xx < Math.min(width, x + w + margin);
          xx++
        ) {
          const p = (yy * width + xx) * 4,
            r = original.data[p],
            g = original.data[p + 1],
            b = original.data[p + 2],
            bright = Math.min(r, g, b) > 225;
          if (inside(xx, yy, source)) {
            count++;
            if (bright) white++;
            if (Math.max(r, g, b) - Math.min(r, g, b) > 35) colored++;
          } else {
            border++;
            if (bright) borderWhite++;
          }
        }
      const safe =
        count > 0 &&
        white / count > 0.6 &&
        colored / count < 0.02 &&
        border > 0 &&
        borderWhite / border > 0.9;
      if (!safe && !(region.render.source_verified && includes.length)) {
        preserve(
          "background cleanup needs a verified mask; original artwork was preserved.",
        );
        continue;
      }
      const words = (region.render.words as number[][]) || [source];
      for (const raw of includes.length
        ? includes
        : words.map((b) => [b[0] - 1, b[1] - 1, b[2] + 2, b[3] + 2])) {
        const [x, y, w, h] = bounded(raw, width, height);
        for (let yy = y; yy < y + h; yy++)
          for (let xx = x; xx < x + w; xx++) {
            const p = (yy * width + xx) * 4;
            if (
              includes.length ||
              Math.min(
                original.data[p],
                original.data[p + 1],
                original.data[p + 2],
              ) < 225
            )
              ink.push(yy * width + xx);
          }
      }
    }
    if (!ink.length) {
      preserve(
        "a safe lettering mask could not be found; original artwork was preserved.",
      );
      continue;
    }
    const layout = fitText(target, region, map);
    if (!layout) {
      preserve(
        "translation could not fit at a readable size; enlarge its placement box.",
      );
      continue;
    }
    if (
      layout.lines.some((l) =>
        excludes.some((b) =>
          overlaps([l.x, l.y, l.width, layout.size * 1.2], b),
        ),
      )
    ) {
      preserve(
        "translation would overlap protected artwork; adjust its placement box.",
      );
      continue;
    }
    const expansion = Math.max(
      0,
      Math.min(4, Number(region.render.mask_dilation ?? 1)),
    );
    const marked = new Set<number>();
    for (const p of ink) {
      const x = p % width,
        y = Math.floor(p / width);
      if (excludes.some((b) => inside(x, y, b))) continue;
      for (let dy = -expansion; dy <= expansion; dy++)
        for (let dx = -expansion; dx <= expansion; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (
            xx < 0 ||
            yy < 0 ||
            xx >= width ||
            yy >= height ||
            excludes.some((b) => inside(xx, yy, b))
          )
            continue;
          if (clip && !inside(xx, yy, clip)) continue;
          marked.add(yy * width + xx);
        }
    }
    for (const p of marked) maskPixels[p] = 1;
    diagnostic.status = "RENDERED_NEEDS_REVIEW";
    diagnostic.mask_pixels = marked.size;
    diagnostic.font_size = layout.size;
    drawable.push({ region, layout });
    await new Promise((r) => setTimeout(r, 0));
  }
  const maskData = maskCtx.createImageData(width, height);
  for (let i = 0; i < maskPixels.length; i++) {
    const p = i * 4;
    if (maskPixels[i]) {
      pixels[p] = pixels[p + 1] = pixels[p + 2] = pixels[p + 3] = 255;
      maskData.data[p] = maskData.data[p + 1] = maskData.data[p + 2] = 255;
    }
    maskData.data[p + 3] = 255;
  }
  cleanCtx.putImageData(new ImageData(pixels, width, height), 0, 0);
  maskCtx.putImageData(maskData, 0, 0);
  target.drawImage(clean, 0, 0);
  for (const { region, layout } of drawable) {
    target.font = layout.size + 'px "MangaLensCJK"';
    target.fillStyle = "#111";
    target.textBaseline = "top";
    const align = String(region.render.align || "center") as CanvasTextAlign;
    target.textAlign = align;
    for (const line of layout.lines) {
      const x =
          line.x +
          (align === "left"
            ? 0
            : align === "right"
              ? line.width
              : line.width / 2) +
          Number(region.render.offset_x || 0),
        y = line.y + Number(region.render.offset_y || 0);
      target.save();
      target.beginPath();
      if (region.render.user_edited)
        target.rect(
          ...(bounded(region.box, width, height) as [
            number,
            number,
            number,
            number,
          ]),
        );
      else target.rect(line.x, line.y, line.width, layout.size * 1.2);
      target.clip();
      target.fillText(line.text, x, y);
      target.restore();
    }
  }
  if (!regions.length)
    warnings.push(
      "No text was recognized. Retry page OCR, or add text regions manually.",
    );
  const result = {
    translated: await blobOf(translated),
    clean: await blobOf(clean),
    mask: await blobOf(mask),
    warnings,
    diagnostics,
  };
  for (const canvas of [clean, translated, mask])
    canvas.width = canvas.height = 0;
  return result;
}
