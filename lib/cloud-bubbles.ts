import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  approved,
  BUBBLE_VERSION,
  polygonBox,
  polygonRows,
  simplePolygon,
  type Bubble,
  type BubbleScan,
  type Point,
} from "./bubble-geometry";
import type { Region } from "./api";
import type { CloudPage } from "./cloud-types";
import type { Tile } from "./cloud-providers";
import { fail, signed } from "./cloud-store";
import { speechMap } from "./page-layout";

export function requireReview(page: CloudPage) {
  if (
    page.bubble_scan?.version !== BUBBLE_VERSION ||
    page.bubble_scan.status !== "ready" ||
    !page.bubble_scan.reviewed
  )
    fail(
      409,
      "Open Preview Detected Bubbles and confirm your selection first.",
    );
}

export function validRegion(page: CloudPage, region: Region) {
  return approved(page.bubble_scan).some(
    (bubble) =>
      region.render.bubble_id === bubble.id &&
      region.render.bubble_version === BUBBLE_VERSION &&
      JSON.stringify(region.render.bubble_polygon) ===
        JSON.stringify(bubble.polygon),
  );
}

export function configureBubbles(
  page: CloudPage,
  direction: string,
  reset = false,
) {
  requireReview(page);
  if (page.lease && page.lease.until > Date.now())
    fail(409, "Pause processing before changing the page selection.");
  const selections = approved(page.bubble_scan);
  selections.sort((a, b) => {
    const [ax, ay] = polygonBox(a.polygon),
      [bx, by] = polygonBox(b.polygon);
    const band = Math.max(1, Math.floor(page.height / 10));
    return (
      Math.floor(ay / band) - Math.floor(by / band) ||
      (direction === "ltr"
        ? ax - bx
        : direction === "vertical"
          ? ay - by
          : bx - ax)
    );
  });
  page.regions = page.regions.filter(
    (r) =>
      validRegion(page, r) &&
      (!reset ||
        r.render.source_verified ||
        r.render.user_edited ||
        r.restored),
  );
  page.metrics = {
    ...page.metrics,
    bubble_order: selections.map((bubble) => bubble.id),
    layout_version: 3,
  };
  page.tiles_done = selections.flatMap((bubble, index) =>
    page.regions.some((r) => r.render.bubble_id === bubble.id) ? [index] : [],
  );
  page.tile_count = selections.length;
  page.translated = false;
  page.status = "queued";
  page.lease = undefined;
  page.error = "";
  return page;
}

async function readAsset(path: string) {
  const response = await fetch(await signed(path), {
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    fail(502, "The original or rendered image could not be loaded.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024)
    fail(400, "Image exceeds the hosted page limit.");
  return sharp(bytes, { limitInputPixels: 12_000_000 })
    .toColourspace("srgb")
    .ensureAlpha();
}

function rectangularFilter(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
  solid: boolean,
) {
  const stride = width + 1;
  const integral = new Int32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += mask[y * width + x];
      integral[(y + 1) * stride + x + 1] = row + integral[y * stride + x + 1];
    }
  }
  return mask.map((_, index) => {
    const x = index % width,
      y = Math.floor(index / width);
    const left = Math.max(0, x - radius),
      right = Math.min(width, x + radius + 1);
    const top = Math.max(0, y - radius),
      bottom = Math.min(height, y + radius + 1);
    const count =
      integral[bottom * stride + right] -
      integral[bottom * stride + left] -
      integral[top * stride + right] +
      integral[top * stride + left];
    return Number(
      solid ? count === (right - left) * (bottom - top) : count > 0,
    );
  });
}

function componentSizes(ink: Uint8Array, width: number) {
  const sizes = [];
  for (let index = 0; index < ink.length; index++) {
    if (!ink[index]) continue;
    ink[index] = 0;
    const queue = [index];
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      for (const neighbor of [
        p % width ? p - 1 : -1,
        p % width < width - 1 ? p + 1 : -1,
        p - width,
        p + width,
      ]) {
        if (!ink[neighbor]) continue;
        ink[neighbor] = 0;
        queue.push(neighbor);
      }
    }
    if (queue.length >= 4) sizes.push(queue.length);
  }
  return sizes;
}

function detectBubbles(
  data: Buffer,
  fuzzy: Buffer,
  width: number,
  height: number,
  page: CloudPage,
) {
  const gray = Uint8Array.from({ length: width * height }, (_, i) =>
    Math.round(
      data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114,
    ),
  );
  const radius = Math.max(
    1,
    Math.min(4, Math.round(Math.min(width, height) * 0.004)),
  );
  const dark = gray.map((value) => Number(value < 140));
  const closed = rectangularFilter(
    rectangularFilter(dark, width, height, radius, false),
    width,
    height,
    radius,
    true,
  );
  const bubbles: Bubble[] = [];
  for (const soft of [false, true]) {
    const pixels = new Uint8ClampedArray(data.length);
    for (let index = 0; index < gray.length; index++) {
      const value = soft
        ? fuzzy[index * 4] > 228
        : gray[index] > 185 && !closed[index];
      if (value) pixels.fill(255, index * 4, index * 4 + 4);
    }
    const map = speechMap({ data: pixels, width, height }, 0.38);
    for (const area of map.areas.values()) {
      const [x, y, w, h] = area.box;
      if (Math.min(w, h) < 26 || area.area < 600 || Math.max(w / h, h / w) > 5)
        continue;
      const nearTop = Math.floor(h * 0.08),
        middle = Math.floor(h / 2);
      const rowWidth = (i: number) => area.right[i] - area.left[i];
      if (
        rowWidth(nearTop) > rowWidth(middle) * 0.975 &&
        rowWidth(h - 1 - nearTop) > rowWidth(middle) * 0.975 &&
        area.area / (w * h) > 0.93
      )
        continue;
      const pad = Math.max(2, Math.round(Math.min(w, h) * 0.034));
      const sampleRows = Array.from({ length: 28 }, (_, i) =>
        Math.round(pad + ((h - 1 - 2 * pad) * i) / 27),
      );
      const rows = [...new Set(sampleRows)].filter(
        (i) => rowWidth(i) >= Math.max(2 * pad + 1, w * 0.28),
      );
      if (rows.length < 5) continue;
      const left: Point[] = rows.map((i) => [area.left[i] + pad, y + i]);
      const right = rows
        .map((i): Point => [area.right[i] - pad, y + i])
        .reverse();
      const contour = polygonRows([...left, ...right]);
      const fill = new Uint8Array(w * h);
      let bright = 0,
        total = 0,
        support = 0,
        border = 0,
        exterior = 0,
        clipped = false;
      for (let yy = 0; yy < h; yy++) {
        if (rowWidth(yy) < w * 0.28) continue;
        const row = (y + yy) * width;
        for (const [edge, sign] of [
          [area.left[yy], -1],
          [area.right[yy], 1],
        ]) {
          const near = edge + sign * 2;
          const far = edge + sign * 5;
          if (near < 0 || near >= width || far < 0 || far >= width) continue;
          border++;
          if (gray[row + near] < (soft ? 225 : 185)) support++;
          if (gray[row + far] > 220) exterior++;
        }
        for (let xx = x; xx < x + w; xx++) {
          if (!contour.contains(xx, y + yy)) continue;
          total++;
          const value = gray[row + xx];
          if (value >= 240) bright++;
          if (value < 155) {
            fill[yy * w + xx - x] = 1;
            if (
              !contour.contains(xx - 1, y + yy) ||
              !contour.contains(xx + 1, y + yy) ||
              !contour.contains(xx, y + yy - 1) ||
              !contour.contains(xx, y + yy + 1)
            )
              clipped = true;
          }
        }
      }
      const sizes = componentSizes(fill, w);
      const ink = sizes.reduce((sum, size) => sum + size, 0);
      if (
        sizes.length < 2 ||
        ink < 32 ||
        bright / total < 0.61 ||
        ink / total < 0.007 ||
        ink / total > 0.19 ||
        Math.max(...sizes) > ink * 0.68 ||
        support / border < 0.24
      )
        continue;
      const round = area.area / (w * h);
      const detection =
        !clipped &&
        bright / total >= 0.76 &&
        (soft
          ? support / border >= 0.54 && round >= 0.67
          : support / border >= 0.52 &&
            (round >= 0.7 || (exterior / border >= 0.34 && sizes.length >= 9)))
          ? "accepted"
          : "uncertain";
      const polygon = [...left, ...right].map(([px, py]): Point => [
        Math.floor((px * page.width) / width),
        Math.floor((py * page.height) / height),
      ]);
      const centerX = Math.round(((x + w / 2) * page.width) / width);
      const centerY = Math.round(((y + h / 2) * page.height) / height);
      if (
        bubbles.some((bubble) =>
          polygonRows(bubble.polygon).contains(centerX, centerY),
        )
      )
        continue;
      bubbles.push({
        id: randomUUID(),
        polygon,
        detection,
        decision: detection === "accepted" ? "approved" : "pending",
        reason:
          detection === "uncertain"
            ? "Check where the bubble ends and the artwork begins."
            : undefined,
      });
      if (bubbles.length >= 80) return bubbles;
    }
  }
  return bubbles;
}

export async function scanBubbles(page: CloudPage): Promise<BubbleScan> {
  const revision = randomUUID();
  try {
    if (!page.uploaded) fail(409, "Finish importing the page before scanning.");
    if (page.lease && page.lease.until > Date.now())
      fail(409, "Pause translation before scanning.");
    const image = await readAsset(page.assets.original);
    const { data, info } = await image
      .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const fuzzy = await sharp(data, { raw: { ...info, channels: 4 } })
      .blur(1.5)
      .raw()
      .toBuffer();
    const bubbles = detectBubbles(data, fuzzy, info.width, info.height, page);
    return {
      version: BUBBLE_VERSION,
      revision,
      status: "ready",
      reviewed: !bubbles.length,
      bubbles: bubbles.slice(0, 80),
    };
  } catch (error) {
    return {
      version: BUBBLE_VERSION,
      revision,
      status: "failed",
      reviewed: false,
      bubbles: [],
      reason:
        error instanceof Error && error.name === "TimeoutError"
          ? "The image read timed out."
          : "The original image could not be decoded for bubble scanning.",
    };
  }
}

export function saveReview(
  page: CloudPage,
  input: { revision?: string; bubbles?: unknown; skip?: boolean },
): BubbleScan {
  const scan = page.bubble_scan;
  if (!scan || scan.status !== "ready" || scan.revision !== input.revision)
    return fail(409, "The bubble scan changed. Reopen the preview.");
  if (!Array.isArray(input.bubbles) || input.bubbles.length > 100)
    return fail(422, "Invalid bubble selections.");
  const seen = new Set<string>();
  const bubbles = input.bubbles.map((value) => {
    if (
      !value ||
      !Array.isArray(value.polygon) ||
      !["approved", "pending", "dismissed"].includes(value.decision)
    )
      return fail(422, "Invalid bubble selection.");
    const saved = scan.bubbles.find((b) => b.id === value.id);
    if (value.id && (!saved || seen.has(value.id)))
      return fail(422, "Unknown or duplicate bubble.");
    if (saved) seen.add(saved.id);
    const polygon: Point[] = value.polygon;
    if (
      polygon.length < 3 ||
      polygon.length > 120 ||
      polygon.some(
        (point) =>
          !Array.isArray(point) ||
          point.length !== 2 ||
          !point.every(Number.isInteger) ||
          point[0] < 0 ||
          point[0] >= page.width ||
          point[1] < 0 ||
          point[1] >= page.height,
      )
    )
      return fail(422, "Draw a bubble outline inside the page.");
    if (!simplePolygon(polygon)) return fail(422, "Bubble edges cannot cross.");
    const coverage = polygonRows(polygon);
    const area = coverage.rows.reduce(
      (sum, row) =>
        sum + row.reduce((n, cut, i) => n + (i % 2 ? cut : -cut), 0),
      0,
    );
    if (area < 150 || area > page.width * page.height * 0.85)
      return fail(422, "Draw a boundary around one speech bubble.");
    const changed =
      !saved || JSON.stringify(saved.polygon) !== JSON.stringify(polygon);
    if (
      value.decision === "approved" &&
      (changed || saved?.decision === "pending") &&
      value.confirmed !== true
    )
      return fail(
        422,
        "Confirm the outline before including this speech bubble.",
      );
    return {
      id: saved?.id || randomUUID(),
      polygon,
      decision: value.decision,
      detection: changed ? "manual" : saved.detection,
    } as Bubble;
  });
  if (seen.size !== scan.bubbles.length)
    return fail(422, "Deselect unwanted candidates before saving.");
  const selected = bubbles
    .filter((bubble) => bubble.decision === "approved")
    .map((bubble) => polygonRows(bubble.polygon));
  const occupied = new Uint8Array(page.width * page.height);
  for (const shape of selected)
    for (const [index, cuts] of shape.rows.entries())
      for (let i = 0; i < cuts.length; i += 2) {
        const start = (shape.y + index) * page.width + cuts[i];
        const end = (shape.y + index) * page.width + cuts[i + 1];
        if (occupied.subarray(start, end).includes(1))
          return fail(422, "Approved bubbles cannot overlap.");
        occupied.fill(1, start, end);
      }
  if (input.skip && bubbles.some((bubble) => bubble.decision !== "dismissed"))
    return fail(422, "Dismiss each candidate before skipping the page.");
  return {
    ...scan,
    revision: randomUUID(),
    bubbles,
    reviewed: !!selected.length || !bubbles.length || !!input.skip,
  };
}

export async function maskedTile(
  page: CloudPage,
  bubble: Bubble,
  index: number,
): Promise<Tile | null> {
  const shape = polygonRows(bubble.polygon);
  const crop = await readAsset(page.assets.original);
  const { x, y, width, height } = shape;
  const pixels = await crop
    .extract({ left: x, top: y, width, height })
    .raw()
    .toBuffer();
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      const offset = (row * width + col) * 4;
      const px = x + col,
        py = y + row;
      if (!shape.contains(px, py)) pixels.fill(255, offset, offset + 4);
      else if (
        Math.min(...pixels.subarray(offset, offset + 3)) < 145 &&
        (!shape.contains(px - 1, py) ||
          !shape.contains(px + 1, py) ||
          !shape.contains(px, py - 1) ||
          !shape.contains(px, py + 1))
      )
        return null;
    }
  const jpeg = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .jpeg({ quality: 88 })
    .toBuffer();
  if (jpeg.length > 1_000_000)
    fail(422, "The selected bubble is too large for cloud OCR.");
  return {
    x,
    y,
    width,
    height,
    index,
    count: page.tile_count,
    base64: jpeg.toString("base64"),
  };
}

export async function verifyApprovedPixels(
  page: CloudPage,
  assets: Record<string, string>,
) {
  const originalImage = await readAsset(page.assets.original);
  const original = await originalImage.raw().toBuffer();
  const mask = Buffer.alloc(page.width * page.height);
  for (const bubble of approved(page.bubble_scan)) {
    const shape = polygonRows(bubble.polygon);
    for (const [index, cuts] of shape.rows.entries()) {
      const row = (shape.y + index) * page.width;
      for (let i = 0; i < cuts.length; i += 2)
        mask.fill(1, row + cuts[i], row + cuts[i + 1]);
    }
  }
  for (const kind of ["translated", "clean", "mask"]) {
    const image = await readAsset(assets[kind]);
    const pixels = await image.raw().toBuffer();
    if (pixels.length !== original.length)
      fail(422, "The rendered page has different dimensions.");
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) continue;
      const p = i * 4;
      if (
        kind === "mask"
          ? pixels[p] || pixels[p + 1] || pixels[p + 2]
          : pixels[p] !== original[p] ||
            pixels[p + 1] !== original[p + 1] ||
            pixels[p + 2] !== original[p + 2] ||
            pixels[p + 3] !== original[p + 3]
      )
        fail(422, "Changes outside the approved speech bubbles were rejected.");
    }
  }
}
