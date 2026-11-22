import type { Region } from "./api";
import { boundaryInk, polygonRows, type Point } from "./bubble-geometry";
import { canvasOf } from "./browser-pages";
import { typesettingFamily } from "./browser-fonts";
import {
  BOUNDARY,
  CLEANUP,
  TOO_LONG,
  type LayoutDebug,
  type PixelRun,
} from "./render-feedback";
type Crop = { x: number; y: number; width: number; height: number };
type Line = { text: string; x: number; baseline: number };

function describe(
  debug: LayoutDebug,
  key: "source" | "placement" | "rejected",
  crop: Crop,
  pixels: Uint8Array,
) {
  const spans: PixelRun[] = [];
  const { x, y, width, height } = crop;
  debug[key] = spans;
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      if (!pixels[row * width + col]) continue;
      const left = col;
      while (col + 1 < width && pixels[row * width + col + 1]) col++;
      if (spans.length === 400) {
        debug[`${key}_truncated`] = true;
        return;
      }
      spans.push([x + left, y + row, col - left + 1]);
    }
  debug[`${key}_truncated`] = false;
}

function inset(inside: Uint8Array, { width, height }: Crop, pad: number) {
  const stride = width + 1;
  const sum = new Int32Array((height + 1) * stride);
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += inside[y * width + x];
      sum[(y + 1) * stride + x + 1] = row + sum[y * stride + x + 1];
    }
  }
  const mask = new Uint8Array(inside.length);
  const area = (2 * pad + 1) ** 2;
  for (let y = pad; y < height - pad; y++)
    for (let x = pad; x < width - pad; x++) {
      const a = x - pad,
        b = x + pad + 1,
        top = (y - pad) * stride,
        bottom = (y + pad + 1) * stride;
      mask[y * width + x] = Number(
        sum[bottom + b] - sum[bottom + a] - sum[top + b] + sum[top + a] ===
          area,
      );
    }
  return mask;
}

function filter(
  gray: Uint8Array,
  { width, height }: Crop,
  radius: number,
  maximum: boolean,
) {
  const temporary = new Uint8Array(gray.length);
  const output = new Uint8Array(gray.length);
  const pass = (
    input: Uint8Array,
    result: Uint8Array,
    rows: number,
    length: number,
    stride: number,
    distance: number,
  ) => {
    const queue = new Int32Array(length);
    for (let row = 0; row < rows; row++) {
      let head = 0,
        tail = 0,
        cursor = 0;
      const origin = row * distance;
      for (let i = 0; i < length; i++) {
        while (cursor < length && cursor <= i + radius) {
          const value = input[origin + cursor * stride];
          while (head < tail) {
            const last = input[origin + queue[tail - 1] * stride];
            if (maximum ? value < last : value > last) break;
            tail--;
          }
          queue[tail++] = cursor++;
        }
        while (queue[head] < i - radius) head++;
        result[origin + i * stride] = input[origin + queue[head] * stride];
      }
    }
  };
  pass(gray, temporary, height, width, 1, width);
  pass(temporary, output, width, height, width, 1);
  return output;
}

function dilate(pixels: Uint8Array, crop: Crop, radius: number) {
  return filter(pixels, crop, radius, true);
}

function luminance(r: number, g: number, b: number) {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

function contains(x: number, y: number, box: number[], margin = 0) {
  return (
    x >= box[0] - margin &&
    y >= box[1] - margin &&
    x < box[0] + box[2] + margin &&
    y < box[1] + box[3] + margin
  );
}

function lettering(
  data: Uint8ClampedArray,
  crop: Crop,
  inside: Uint8Array,
  cleanup: Uint8Array,
  rim: Uint8Array,
  region: Region,
  debug: LayoutDebug,
) {
  const { x, y, width, height } = crop;
  const gray = inside.map((value, i) =>
    value ? luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) : 0,
  );
  const reference = filter(dilate(gray, crop, 10), crop, 10, false);
  const base = gray.map((g, i) =>
    inside[i] && !rim[i] && reference[i] - g >= 22 ? 1 : 0,
  );
  const excluded = inside.map((_, i) =>
    Number(
      ((region.render.mask_exclude as number[][]) || []).some((box) =>
        contains(x + (i % width), y + Math.floor(i / width), box),
      ),
    ),
  );
  const sources = [
    (region.render.source_box as number[]) || region.box,
    ...((region.render.mask_include as number[][]) || []),
  ];
  const margin = Math.max(
    5,
    Math.min(18, Math.round(Math.min(width, height) * 0.12)),
  );
  const ink = new Uint8Array(base.length),
    rejected = new Uint8Array(base.length);
  const body = inset(
    inside,
    crop,
    Math.min(8, Math.max(3, Math.floor(Math.min(width, height) / 8))),
  );
  for (let start = 0; start < base.length; start++) {
    if (!base[start]) continue;
    const component = [start];
    base[start] = 0;
    let minX = width,
      maxX = 0,
      minY = height,
      maxY = 0,
      anchors = 0,
      nearby = 0;
    let touches = false,
      bodyPixels = 0,
      protectedInk = false;
    for (let head = 0; head < component.length; head++) {
      const index = component[head],
        col = index % width,
        row = Math.floor(index / width);
      minX = Math.min(minX, col);
      maxX = Math.max(maxX, col);
      minY = Math.min(minY, row);
      maxY = Math.max(maxY, row);
      if (sources.some((box) => contains(x + col, y + row, box))) anchors++;
      if (sources.some((box) => contains(x + col, y + row, box, margin)))
        nearby++;
      touches ||= !cleanup[index];
      bodyPixels += body[index];
      protectedInk ||= !!excluded[index];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (
            col + dx < 0 ||
            col + dx >= width ||
            row + dy < 0 ||
            row + dy >= height
          )
            continue;
          const neighbor = index + dy * width + dx;
          if (!base[neighbor]) continue;
          base[neighbor] = 0;
          component.push(neighbor);
        }
    }
    const size = component.length,
      w = maxX - minX + 1,
      h = maxY - minY + 1;
    if (touches) {
      continue;
    } else if (!nearby) {
      if (
        bodyPixels > 0 &&
        size >= 10 &&
        size <= 0.055 * width * height &&
        w <= width * 0.5 &&
        h <= height * 0.5
      )
        for (const i of component) rejected[i] = 1;
    } else if (
      size > 0.13 * width * height ||
      w > width * 0.8 ||
      h > height * 0.8 ||
      protectedInk
    ) {
      if (anchors) for (const i of component) rejected[i] = 1;
    } else if (anchors || nearby >= size * 0.5) {
      for (const i of component) ink[i] = 1;
    }
  }
  if (rejected.includes(1) || !ink.includes(1)) {
    describe(debug, "source", crop, ink);
    describe(debug, "rejected", crop, rejected);
    return { reason: CLEANUP };
  }
  const fringe = dilate(ink, crop, 2);
  const expected = ink.map((value, i) =>
    value ||
    (fringe[i] &&
      cleanup[i] &&
      !rim[i] &&
      !excluded[i] &&
      reference[i] - gray[i] >= 5)
      ? 1
      : 0,
  );
  const constrain = (mask: Uint8Array) =>
    mask.map((value, i) => (cleanup[i] && !rim[i] && !excluded[i] ? value : 0));
  let mask = constrain(
    dilate(
      expected,
      crop,
      Math.max(1, Math.min(4, Number(region.render.mask_dilation ?? 1))),
    ),
  );
  const area = cleanup.reduce((sum, n) => sum + n, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    describe(debug, "source", crop, mask);
    if (mask.reduce((sum, n) => sum + n, 0) > area * 0.45) break;
    const ring = dilate(mask, crop, 5);
    const samples = [[], [], []] as number[][];
    for (let i = 0; i < mask.length; i++)
      if (ring[i] && !mask[i] && cleanup[i] && !excluded[i])
        for (let c = 0; c < 3; c++) samples[c].push(data[i * 4 + c]);
    if (samples[0].length < 8) break;
    const background = samples.map(
      (values) => [...values].sort((a, b) => a - b)[values.length >> 1],
    );
    const uniform =
      samples[0].filter((_, i) =>
        samples.every((channel, c) => Math.abs(channel[i] - background[c]) < 9),
      ).length >=
      samples[0].length * 0.87;
    const clean = new Uint8ClampedArray(data);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      if (uniform) {
        clean.set(background, i * 4);
        continue;
      }
      // Reconstruct only marked strokes from unobscured neighboring colors.
      const col = i % width,
        row = Math.floor(i / width);
      const sum = [0, 0, 0];
      let weights = 0;
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        for (let step = 1; step <= 36; step++) {
          const px = col + dx * step,
            py = row + dy * step,
            p = py * width + px;
          if (px < 0 || px >= width || py < 0 || py >= height || !cleanup[p])
            break;
          if (mask[p] || excluded[p]) continue;
          const weight = 1 / (step * Math.hypot(dx, dy));
          weights += weight;
          for (let c = 0; c < 3; c++) sum[c] += data[p * 4 + c] * weight;
          break;
        }
      }
      if (weights)
        clean.set(
          sum.map((value) => value / weights),
          i * 4,
        );
    }
    const residual = expected.map((value, i) =>
      value &&
      (!mask[i] ||
        reference[i] -
          luminance(clean[i * 4], clean[i * 4 + 1], clean[i * 4 + 2]) >
          (uniform ? 12 : 22))
        ? 1
        : 0,
    );
    if (!residual.includes(1)) return { clean, mask };
    describe(debug, "rejected", crop, residual);
    mask = constrain(
      dilate(
        mask.map((value, i) => value || residual[i]),
        crop,
        2,
      ),
    );
  }
  // If shaded reconstruction still leaves ghosting, overpaint only the
  // proposed lettering mask. Require a pale, nearly neutral local background.
  const sourceMask = constrain(dilate(expected, crop, 2));
  const ring = dilate(sourceMask, crop, 5);
  const tones: number[] = [];
  let sampled = 0;
  for (let i = 0; i < ring.length; i++) {
    if (!ring[i] || sourceMask[i] || !cleanup[i] || excluded[i]) continue;
    sampled++;
    const [r, g, b] = data.subarray(i * 4, i * 4 + 3);
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 12 && Math.min(r, g, b) >= 210)
      tones.push(luminance(r, g, b));
  }
  if (
    tones.length >= 16 &&
    tones.length >= sampled * 0.85 &&
    sourceMask.reduce((count, pixel) => count + pixel, 0) <= area * 0.45
  ) {
    tones.sort((a, b) => a - b);
    const shade = tones[Math.floor(tones.length * 0.8)];
    const clean = new Uint8ClampedArray(data);
    const residual = expected.some(
      (ink, i) => ink && (!sourceMask[i] || reference[i] - shade > 12),
    );
    if (!residual) {
      for (let i = 0; i < sourceMask.length; i++) {
        if (sourceMask[i]) clean.fill(shade, i * 4, i * 4 + 3);
      }
      describe(debug, "source", crop, sourceMask);
      return { clean, mask: sourceMask };
    }
  }
  if (!debug.rejected?.length) describe(debug, "rejected", crop, expected);
  return { reason: CLEANUP };
}

function fit(
  crop: Crop,
  allowed: Uint8Array,
  cleaned: Uint8ClampedArray,
  region: Region,
  debug: LayoutDebug,
) {
  const { width, height } = crop;
  const translation = region.translation.replace(/\r\n?/g, "\n");
  const thai = /[\u0e00-\u0e7f]/u.test(translation);
  const segmenter = thai
    ? new Intl.Segmenter("th", { granularity: "word" })
    : null;
  const paragraphs = translation
    .split("\n")
    .map((line) =>
      segmenter
        ? Array.from(segmenter.segment(line), ({ segment }) => segment)
        : line.match(
            /[\u2e80-\u9fff\uf900-\ufaff]|[^\s\u2e80-\u9fff\uf900-\ufaff]+|[^\S\n]+/gu,
          ) || [],
    );
  const offX = Number(region.render.offset_x || 0),
    offY = Number(region.render.offset_y || 0);
  const canvas = canvasOf(1, 1);
  const measure = canvas.getContext("2d")!;
  if (Math.abs(offX) >= width || Math.abs(offY) >= height)
    return { reason: TOO_LONG };
  let blocked: Uint8Array | undefined;
  for (
    let size = Math.min(100, Number(region.render.font_size) || 100);
    size >= 12;
    size--
  ) {
    measure.font = `${size}px "${typesettingFamily(translation)}"`;
    const all = measure.measureText(translation.replace(/\n/g, " "));
    const ascent = Math.ceil(all.actualBoundingBoxAscent),
      descent = Math.ceil(all.actualBoundingBoxDescent);
    const glyphHeight = Math.max(1, ascent + descent);
    const firstCount = Math.max(
      1,
      paragraphs.length,
      Math.floor(all.width / Math.max(1, width)) - 1,
    );
    const step = Math.max(
      glyphHeight + 2,
      Math.ceil(size * (firstCount >= 4 ? 1.15 : 1.22)),
    );
    const maxCount = Math.floor((height - glyphHeight) / step) + 1;
    for (
      let count = firstCount;
      count <= Math.min(maxCount, firstCount + 9);
      count++
    ) {
      const block = glyphHeight + (count - 1) * step;
      for (const alignment of [0.5, 0.33, 0.67, 0.15, 0.85]) {
        const first = Math.round((height - block) * alignment);
        let paragraph = 0,
          token = 0;
        const lines: Line[] = [];
        for (let lineIndex = 0; lineIndex < count; lineIndex++) {
          const top = first + lineIndex * step + offY;
          if (top < 0 || top + glyphHeight > height) break;
          let a = 0,
            b = 0,
            start = 0;
          for (let col = 0; col <= width; col++) {
            let fits = col < width;
            for (let row = top; fits && row < top + glyphHeight; row++)
              if (!allowed[row * width + col]) fits = false;
            if (fits) continue;
            if (col - start > b - a) [a, b] = [start, col];
            start = col + 1;
          }
          if (b <= a) break;
          let value = "";
          while (token < paragraphs[paragraph].length) {
            const next = value + paragraphs[paragraph][token];
            const metrics = measure.measureText(next.trim());
            if (
              metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight >
              b - a
            )
              break;
            value = next;
            token++;
          }
          if (!value && token < paragraphs[paragraph].length) break;
          const text = value.trim();
          if (text) {
            const metrics = measure.measureText(text);
            const spare =
              b -
              a -
              metrics.actualBoundingBoxLeft -
              metrics.actualBoundingBoxRight;
            const shift =
              region.render.align === "left"
                ? 0
                : region.render.align === "right"
                  ? spare
                  : spare / 2;
            lines.push({
              text,
              x: Math.round(a + shift + metrics.actualBoundingBoxLeft + offX),
              baseline: top + ascent,
            });
          }
          if (token === paragraphs[paragraph].length) {
            paragraph++;
            token = 0;
          }
          if (paragraph === paragraphs.length) break;
        }
        if (paragraph !== paragraphs.length || !lines.length) continue;
        const extents = lines.map((line) => ({
          line,
          metrics: measure.measureText(line.text),
        }));
        const left =
          Math.floor(
            Math.min(
              ...extents.map(
                ({ line, metrics }) => line.x - metrics.actualBoundingBoxLeft,
              ),
            ),
          ) - 2;
        const top =
          Math.floor(
            Math.min(
              ...extents.map(
                ({ line, metrics }) =>
                  line.baseline - metrics.actualBoundingBoxAscent,
              ),
            ),
          ) - 2;
        const right =
          Math.ceil(
            Math.max(
              ...extents.map(
                ({ line, metrics }) => line.x + metrics.actualBoundingBoxRight,
              ),
            ),
          ) + 2;
        const bottom =
          Math.ceil(
            Math.max(
              ...extents.map(
                ({ line, metrics }) =>
                  line.baseline + metrics.actualBoundingBoxDescent,
              ),
            ),
          ) + 2;
        const glyphs = canvasOf(right - left, bottom - top);
        const ctx = glyphs.getContext("2d", { willReadFrequently: true })!;
        ctx.font = measure.font;
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "#111";
        for (const line of lines)
          ctx.fillText(line.text, line.x - left, line.baseline - top);
        const raster = ctx.getImageData(0, 0, glyphs.width, glyphs.height).data;
        const rejected = new Uint8Array(allowed.length);
        let drawn = 0,
          overflow = false,
          collision = false;
        for (let i = 3; i < raster.length; i += 4) {
          if (!raster[i]) continue;
          drawn++;
          const p = (i - 3) / 4,
            x = left + (p % glyphs.width),
            y = top + Math.floor(p / glyphs.width);
          if (x < 0 || y < 0 || x >= width || y >= height) {
            overflow = true;
            continue;
          }
          const index = y * width + x;
          if (!allowed[index]) {
            rejected[index] = 1;
            overflow = true;
          } else if (
            luminance(
              cleaned[index * 4],
              cleaned[index * 4 + 1],
              cleaned[index * 4 + 2],
            ) < 110
          ) {
            rejected[index] = 1;
            collision = true;
          }
        }
        if (drawn && !overflow && !collision) {
          delete debug.rejected;
          delete debug.rejected_truncated;
          return { glyphs, size, x: crop.x + left, y: crop.y + top };
        }
        glyphs.width = glyphs.height = 0;
        if (collision && !overflow) blocked = rejected;
        else if (overflow && !blocked)
          describe(debug, "rejected", crop, rejected);
      }
    }
  }
  if (blocked) describe(debug, "rejected", crop, blocked);
  return { reason: blocked ? CLEANUP : TOO_LONG };
}

export function renderApprovedBubble(original: ImageData, region: Region) {
  const shape = polygonRows(region.render.bubble_polygon as Point[]);
  const { x, y, width, height } = shape;
  const debug: LayoutDebug = {};
  const inside = new Uint8Array(width * height);
  for (const [row, cuts] of shape.rows.entries())
    for (let i = 0; i < cuts.length; i += 2)
      inside.fill(1, row * width + cuts[i] - x, row * width + cuts[i + 1] - x);
  const cleanup = inset(inside, shape, 1);
  const placement = inset(
    inside,
    shape,
    Math.max(3, Math.min(12, Math.round(Math.min(width, height) * 0.06))),
  );
  for (let i = 0; i < placement.length; i++)
    if (
      ((region.render.mask_exclude as number[][]) || []).some((box) =>
        contains(x + (i % width), y + Math.floor(i / width), box),
      )
    )
      placement[i] = 0;
  describe(debug, "placement", shape, placement);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * original.width + x) * 4;
    data.set(original.data.subarray(from, from + width * 4), row * width * 4);
  }
  if (region.render.boundary_crossing) {
    const rejected = inside.map((value, i) =>
      value && !cleanup[i] && data[i * 4] < 145 ? 1 : 0,
    );
    describe(debug, "rejected", shape, rejected);
    return { debug, reason: BOUNDARY };
  }
  if (!region.translation.trim())
    return {
      debug,
      reason: String(
        region.render.failure_reason || "No translated text was available.",
      ),
    };
  const { crossing, rim } = boundaryInk(data, shape);
  if (crossing) {
    describe(debug, "rejected", shape, rim);
    return { debug, reason: BOUNDARY };
  }
  const cleaned = lettering(
    data,
    shape,
    inside,
    cleanup,
    dilate(rim, shape, 1),
    region,
    debug,
  );
  if (!cleaned.clean) return { debug, reason: cleaned.reason };
  const text = fit(shape, placement, cleaned.clean, region, debug);
  if (!text.glyphs) return { debug, reason: text.reason };
  return {
    debug,
    crop: shape,
    clean: cleaned.clean,
    mask: cleaned.mask,
    glyphs: text.glyphs,
    size: text.size,
    x: text.x,
    y: text.y,
  };
}
