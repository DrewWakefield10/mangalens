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
        ctx.measureText(word).width > width ? Array.from(word) : [word],
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
export async function renderPage(
  bitmap: ImageBitmap,
  page: CloudPage,
  regions: Region[],
) {
  await loadFont();
  const width = bitmap.width,
    height = bitmap.height;
  const clean = canvasOf(width, height),
    translated = canvasOf(width, height),
    mask = canvasOf(width, height);
  const cleanCtx = clean.getContext("2d", { willReadFrequently: true })!,
    target = translated.getContext("2d")!,
    maskCtx = mask.getContext("2d")!;
  cleanCtx.drawImage(bitmap, 0, 0);
  const original = cleanCtx.getImageData(0, 0, width, height),
    pixels = new Uint8ClampedArray(original.data);
  const maskPixels = new Uint8Array(width * height);
  const drawable: Region[] = [];
  const warnings: string[] = [];
  const fitted = new Map<string, { size: number; lines: string[] }>();
  const protectedBoxes = regions
    .filter((r) => r.restored)
    .map((r) => (r.render.source_box as number[]) || r.box);
  for (const region of regions) {
    if (region.restored || !region.translation.trim()) continue;
    const source = bounded(
      (region.render.source_box as number[]) || region.box,
      width,
      height,
    );
    const [x, y, w, h] = source;
    if (!w || !h) continue;
    const excludes = [
      ...((region.render.mask_exclude as number[][]) || []),
      ...protectedBoxes,
    ];
    const includes = (region.render.mask_include as number[][]) || [];
    let white = 0,
      colored = 0,
      count = 0,
      borderWhite = 0,
      borderCount = 0;
    const margin = 4;
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
        const i = (yy * width + xx) * 4;
        const r = original.data[i],
          g = original.data[i + 1],
          b = original.data[i + 2];
        const isWhite = Math.min(r, g, b) > 225;
        if (inside(xx, yy, source)) {
          count++;
          if (isWhite) white++;
          if (Math.max(r, g, b) - Math.min(r, g, b) > 35) colored++;
        } else {
          borderCount++;
          if (isWhite) borderWhite++;
        }
      }
    const safe =
      count > 0 &&
      white / count > 0.6 &&
      colored / count < 0.02 &&
      borderCount > 0 &&
      borderWhite / borderCount > 0.9;
    if (!safe && !(region.render.source_verified && includes.length)) {
      warnings.push(
        "Region " +
          (regions.indexOf(region) + 1) +
          ": artwork was preserved; select and verify a cleanup mask in the editor.",
      );
      continue;
    }
    const destination = bounded(region.box, width, height);
    let fontSize =
      Number(region.render.font_size) ||
      Math.min(
        60,
        Math.max(
          12,
          Math.sqrt(
            (destination[2] * destination[3]) /
              Math.max(1, region.translation.length),
          ) * 1.35,
        ),
      );
    let fittedLines: string[] = [];
    for (; fontSize >= 12; fontSize -= 0.5) {
      target.font = fontSize + 'px "MangaLensCJK"';
      fittedLines = linesOf(
        target,
        region.translation,
        Math.max(1, destination[2] - 4),
      );
      if (
        fittedLines.length * fontSize * 1.2 <= destination[3] - 4 &&
        fittedLines.every(
          (line) => target.measureText(line).width <= destination[2] - 4,
        )
      )
        break;
    }
    if (
      fontSize < 12 ||
      protectedBoxes.some((b) => inside(destination[0], destination[1], b))
    ) {
      warnings.push(
        "Region " +
          (regions.indexOf(region) + 1) +
          ": text could not fit safely; original artwork was preserved.",
      );
      continue;
    }
    fitted.set(region.id, { size: fontSize, lines: fittedLines });
    const words = (region.render.words as number[][]) || [source];
    const allowed = includes.length
      ? includes
      : words.map((b) => [b[0] - 1, b[1] - 1, b[2] + 2, b[3] + 2]);
    for (const raw of allowed) {
      const [ax, ay, aw, ah] = bounded(raw, width, height);
      for (let yy = ay; yy < ay + ah; yy++)
        for (let xx = ax; xx < ax + aw; xx++) {
          if (excludes.some((b) => inside(xx, yy, b))) continue;
          const index = (yy * width + xx) * 4;
          const dark =
            Math.min(
              original.data[index],
              original.data[index + 1],
              original.data[index + 2],
            ) < 220;
          if (!dark && !includes.length) continue;
          // Target only ink pixels and a one-pixel halo; preserve all excluded artwork.
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = xx + dx,
                ny = yy + dy;
              if (
                nx < 0 ||
                ny < 0 ||
                nx >= width ||
                ny >= height ||
                excludes.some((b) => inside(nx, ny, b))
              )
                continue;
              maskPixels[ny * width + nx] = 1;
            }
        }
    }
    drawable.push(region);
    await new Promise((r) => setTimeout(r, 0));
  }
  const maskData = maskCtx.createImageData(width, height);
  for (let i = 0; i < maskPixels.length; i++) {
    const offset = i * 4;
    if (maskPixels[i]) {
      pixels[offset] =
        pixels[offset + 1] =
        pixels[offset + 2] =
        pixels[offset + 3] =
          255;
      maskData.data[offset] =
        maskData.data[offset + 1] =
        maskData.data[offset + 2] =
          255;
    }
    maskData.data[offset + 3] = 255;
  }
  cleanCtx.putImageData(new ImageData(pixels, width, height), 0, 0);
  maskCtx.putImageData(maskData, 0, 0);
  target.drawImage(clean, 0, 0);
  for (const region of drawable) {
    const [x, y, w, h] = bounded(region.box, width, height);
    const padding = 2;
    const { size, lines } = fitted.get(region.id)!;
    target.font = size + 'px "MangaLensCJK"';
    const align = String(region.render.align || "center") as CanvasTextAlign;
    target.fillStyle = "#111111";
    target.textBaseline = "top";
    target.textAlign = align;
    const tx =
      x +
      (align === "left" ? padding : align === "right" ? w - padding : w / 2) +
      Number(region.render.offset_x || 0);
    const ty =
      y +
      Math.max(padding, (h - lines.length * size * 1.2) / 2) +
      Number(region.render.offset_y || 0);
    target.save();
    target.beginPath();
    target.rect(x, y, w, h);
    target.clip();
    lines.forEach((line, index) =>
      target.fillText(line, tx, ty + index * size * 1.2),
    );
    target.restore();
  }
  if (!regions.length)
    warnings.push(
      "No text was recognized. Add regions and text in the editor.",
    );
  const result = {
    translated: await blobOf(translated),
    clean: await blobOf(clean),
    mask: await blobOf(mask),
    warnings,
  };
  for (const canvas of [clean, translated, mask])
    canvas.width = canvas.height = 0;
  return result;
}
