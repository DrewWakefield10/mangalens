import type { Region } from "./api";
export type Raster = { width: number; height: number; data: Uint8ClampedArray };
export type LayoutGroup = {
  ids: string[];
  box: number[];
  bubble?: number[];
  cleanup?: number[];
};
type Area = {
  id: number;
  box: number[];
  area: number;
  edge: boolean;
  left: Int32Array;
  right: Int32Array;
};
export type SpeechMap = {
  width: number;
  height: number;
  labels: Int32Array;
  areas: Map<number, Area>;
};
export const sourceBox = (r: Region) =>
  (r.render.source_box as number[]) || r.box;
export function union(boxes: number[][]) {
  const x = Math.min(...boxes.map((b) => b[0])),
    y = Math.min(...boxes.map((b) => b[1]));
  return [
    x,
    y,
    Math.max(...boxes.map((b) => b[0] + b[2])) - x,
    Math.max(...boxes.map((b) => b[1] + b[3])) - y,
  ];
}
export function vertical(r: Region) {
  const b = sourceBox(r);
  return (
    /[\u3000-\u9fff\uf900-\ufaff]/u.test(r.source_text) && b[3] > b[2] * 1.45
  );
}
export function speechMap(image: Raster): SpeechMap {
  const { width: w, height: h, data } = image,
    n = w * h;
  const bright = new Uint8Array(n),
    labels = new Int32Array(n),
    queue = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    bright[i] =
      Math.min(data[p], data[p + 1], data[p + 2]) >= 235 &&
      Math.max(data[p], data[p + 1], data[p + 2]) -
        Math.min(data[p], data[p + 1], data[p + 2]) <
        25
        ? 1
        : 0;
  }
  const areas = new Map<number, Area>();
  let id = 0;
  for (let start = 0; start < n; start++) {
    if (!bright[start] || labels[start]) continue;
    id++;
    let head = 0,
      tail = 1,
      minX = w,
      minY = h,
      maxX = 0,
      maxY = 0,
      edge = false;
    queue[0] = start;
    labels[start] = id;
    while (head < tail) {
      const p = queue[head++],
        x = p % w,
        y = Math.floor(p / w);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const q of [
        x > 0 ? p - 1 : -1,
        x < w - 1 ? p + 1 : -1,
        y > 0 ? p - w : -1,
        y < h - 1 ? p + w : -1,
      ])
        if (q >= 0 && bright[q] && !labels[q]) {
          labels[q] = id;
          queue[tail++] = q;
        }
    }
    const bw = maxX - minX + 1,
      bh = maxY - minY + 1;
    // Enclosed, mostly white shapes; page margins and large open artwork are excluded.
    if (
      edge ||
      tail < 100 ||
      tail > n * 0.18 ||
      tail / (bw * bh) < 0.55 ||
      bw < 16 ||
      bh < 16
    )
      continue;
    const left = new Int32Array(bh).fill(w),
      right = new Int32Array(bh).fill(-1);
    for (let i = 0; i < tail; i++) {
      const p = queue[i],
        x = p % w,
        y = Math.floor(p / w) - minY;
      left[y] = Math.min(left[y], x);
      right[y] = Math.max(right[y], x);
    }
    areas.set(id, {
      id,
      box: [minX, minY, bw, bh],
      area: tail,
      edge,
      left,
      right,
    });
  }
  return { width: w, height: h, labels, areas };
}
function areaFor(map: SpeechMap, box: number[]) {
  const [x, y, w, h] = box,
    counts = new Map<number, number>();
  for (
    let yy = Math.max(0, Math.floor(y));
    yy < Math.min(map.height, y + h);
    yy++
  )
    for (
      let xx = Math.max(0, Math.floor(x));
      xx < Math.min(map.width, x + w);
      xx++
    ) {
      const id = map.labels[yy * map.width + xx];
      if (map.areas.has(id)) counts.set(id, (counts.get(id) || 0) + 1);
    }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const best = ranked[0] && map.areas.get(ranked[0][0]);
  if (!best || ranked[0][1] < w * h * 0.12) return;
  const b = best.box;
  const tolerance = Math.max(6, Math.min(24, Math.min(w, h) * 0.8));
  if (
    x < b[0] - tolerance ||
    y < b[1] - tolerance ||
    x + w > b[0] + b[2] + tolerance ||
    y + h > b[1] + b[3] + tolerance
  )
    return;
  return best;
}
export function layoutGroups(image: Raster, regions: Region[]) {
  const map = speechMap(image),
    groups = new Map<string, { members: Region[]; area?: Area }>();
  for (const r of regions) {
    const editable =
      r.kind === "manual" ||
      r.restored ||
      r.render.user_edited ||
      r.render.source_verified;
    const area = editable ? undefined : areaFor(map, sourceBox(r));
    // Provider paragraphs distinguish adjacent balloons connected by a white gap.
    const paragraph =
      typeof r.render.ocr_paragraph === "string" ? r.render.ocr_paragraph : "";
    const key = area
      ? "bubble:" + area.id + (paragraph ? ":" + paragraph : "")
      : "region:" + r.id;
    const group = groups.get(key) || { members: [], area };
    group.members.push(r);
    groups.set(key, group);
  }
  const all = [...groups.values()];
  return all.map(({ members, area }) => {
    if (!area) return { ids: members.map((r) => r.id), box: members[0].box };
    const source = union(members.map(sourceBox)),
      peers = all.filter((g) => g.area?.id === area.id);
    let clip = [...area.box];
    if (peers.length > 1) {
      const centers = peers.map((g) => {
        const b = union(g.members.map(sourceBox));
        return [b[0] + b[2] / 2, b[1] + b[3] / 2];
      });
      const spread = (axis: number) =>
        Math.max(...centers.map((c) => c[axis])) -
        Math.min(...centers.map((c) => c[axis]));
      const axis = spread(0) >= spread(1) ? 0 : 1,
        center = source[axis] + source[axis + 2] / 2;
      const lower = centers.map((c) => c[axis]).filter((c) => c < center - 1),
        upper = centers.map((c) => c[axis]).filter((c) => c > center + 1);
      const start = lower.length
        ? Math.round((Math.max(...lower) + center) / 2)
        : area.box[axis];
      const end = upper.length
        ? Math.round((Math.min(...upper) + center) / 2)
        : area.box[axis] + area.box[axis + 2];
      clip[axis] = start;
      clip[axis + 2] = Math.max(1, end - start);
    }
    const [cx, cy, cw, ch] = clip;
    return {
      ids: members.map((r) => r.id),
      box: [cx + 4, cy + 4, Math.max(1, cw - 8), Math.max(1, ch - 8)],
      bubble: area.box,
      cleanup: clip,
    };
  });
}
export function ordered(members: Region[]) {
  const isVertical = members.filter(vertical).length > members.length / 2;
  const sameParagraph = members.every(
    (r) =>
      typeof r.render.ocr_paragraph === "string" &&
      r.render.ocr_paragraph === members[0].render.ocr_paragraph,
  );
  return [...members].sort((a, b) => {
    if (
      sameParagraph &&
      typeof a.render.ocr_order === "number" &&
      typeof b.render.ocr_order === "number"
    )
      return a.render.ocr_order - b.render.ocr_order;
    const aa = sourceBox(a),
      bb = sourceBox(b);
    return isVertical
      ? Math.abs(aa[0] - bb[0]) > Math.min(aa[2], bb[2]) * 0.5
        ? bb[0] - aa[0]
        : aa[1] - bb[1]
      : Math.abs(aa[1] - bb[1]) > Math.min(aa[3], bb[3]) * 0.5
        ? aa[1] - bb[1]
        : aa[0] - bb[0];
  });
}
export function prepareRegions(regions: Region[], groups: LayoutGroup[]) {
  const byId = new Map(regions.map((r) => [r.id, r]));
  return groups.map((group) => {
    const members = ordered(group.ids.map((id) => byId.get(id)!)),
      first = structuredClone(members[0]);
    const protectedRegion = members.some(
      (r) =>
        r.kind === "manual" ||
        r.restored ||
        r.render.user_edited ||
        r.render.source_verified,
    );
    if (protectedRegion) return first;
    const merged = members.length > 1;
    first.source_text = members
      .map((r) => r.source_text.trim())
      .join(
        members.some((r) => /[\u3000-\u9fff]/u.test(r.source_text)) ? "" : " ",
      );
    first.orientation = members.some(vertical) ? "vertical" : "horizontal";
    first.box = group.box;
    if (merged) first.translation = "";
    first.render = {
      ...first.render,
      source_box: union(members.map(sourceBox)),
      words: members.flatMap(
        (r) => (r.render.words as number[][]) || [sourceBox(r)],
      ),
      ...(group.bubble
        ? {
            speech_bubble: group.bubble,
            cleanup_box: group.cleanup || group.bubble,
          }
        : {}),
      layout_version: 2,
      source_members: members.flatMap(
        (r) =>
          (r.render.source_members as unknown[]) || [
            { id: r.id, text: r.source_text, box: sourceBox(r) },
          ],
      ),
    };
    return first;
  });
}
export function bubbleInk(
  image: Raster,
  map: SpeechMap,
  bounds: number[],
  clip = bounds,
) {
  const area =
    [...map.areas.values()].find((a) =>
      a.box.every((v, i) => Math.abs(v - bounds[i]) < 2),
    ) ||
    areaFor(map, [
      bounds[0] + bounds[2] * 0.25,
      bounds[1] + bounds[3] * 0.25,
      bounds[2] * 0.5,
      bounds[3] * 0.5,
    ]);
  if (!area) return [];
  const [x, y, w, h] = area.box,
    visited = new Uint8Array(w * h),
    result: number[] = [];
  const dark = (xx: number, yy: number) => {
    const p = (yy * image.width + xx) * 4;
    return Math.min(image.data[p], image.data[p + 1], image.data[p + 2]) < 225;
  };
  const interior = (xx: number, yy: number) => {
    const row = yy - y;
    return (
      row >= 3 &&
      row < h - 3 &&
      xx >
        Math.max(area.left[row - 2], area.left[row], area.left[row + 2]) + 2 &&
      xx <
        Math.min(area.right[row - 2], area.right[row], area.right[row + 2]) - 2
    );
  };
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      const key = (yy - y) * w + xx - x;
      if (visited[key] || !dark(xx, yy)) continue;
      const pending = [key],
        component: number[] = [];
      visited[key] = 1;
      let safe = true;
      for (let head = 0; head < pending.length; head++) {
        const p = pending[head],
          px = x + (p % w),
          py = y + Math.floor(p / w);
        component.push(py * image.width + px);
        if (
          !interior(px, py) ||
          px < clip[0] + 1 ||
          py < clip[1] + 1 ||
          px >= clip[0] + clip[2] - 1 ||
          py >= clip[1] + clip[3] - 1
        )
          safe = false;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx,
              ny = py + dy;
            if (nx < x || ny < y || nx >= x + w || ny >= y + h) continue;
            const index = (ny - y) * w + nx - x;
            if (!visited[index] && dark(nx, ny)) {
              visited[index] = 1;
              pending.push(index);
            }
          }
      }
      if (safe && component.length < area.area * 0.16) {
        for (const pixel of component) result.push(pixel);
      }
    }
  return result;
}
