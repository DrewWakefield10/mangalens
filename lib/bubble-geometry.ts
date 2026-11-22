export type Point = [number, number];
export type Bubble = {
  id: string;
  polygon: Point[];
  detection: "accepted" | "uncertain" | "manual";
  decision: "approved" | "dismissed" | "pending";
  reason?: string;
};
export type BubbleScan = {
  version: string;
  revision: string;
  status: "ready" | "failed";
  bubbles: Bubble[];
  reason?: string;
  reviewed: boolean;
};
export const BUBBLE_VERSION = "speech-bubbles-v1";

export function simplePolygon(points: Point[]) {
  if (new Set(points.map(point => point.join(","))).size !== points.length)
    return false;
  const side = ([ax, ay]: Point, [bx, by]: Point, [cx, cy]: Point) =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      const boxesMeet = ([0, 1] as const).every(axis =>
        Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) <=
        Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])));
      if (boxesMeet && side(a, b, c) * side(a, b, d) <= 0 && side(c, d, a) * side(c, d, b) <= 0)
        return false;
    }
  }
  return true;
}

export function polygonBox(points: Point[]): [number, number, number, number] {
  const xs = points.map(([x]) => x),
    ys = points.map(([, y]) => y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x + 1, Math.max(...ys) - y + 1];
}

export function polygonRows(points: Point[]) {
  const [x, y, width, height] = polygonBox(points);
  const rows: number[][] = [];
  for (let row = y; row < y + height; row++) {
    const cuts: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i],
        [bx, by] = points[(i + 1) % points.length];
      if (ay > row + 0.5 !== by > row + 0.5)
        cuts.push(ax + (bx - ax) * ((row + 0.5 - ay) / (by - ay)));
    }
    rows.push(
      cuts.sort((a, b) => a - b).map((value) => Math.ceil(value - 0.5)),
    );
  }
  return {
    x,
    y,
    width,
    height,
    rows,
    contains(px: number, py: number) {
      const cuts = rows[py - y];
      if (!cuts) return false;
      for (let i = 0; i < cuts.length; i += 2)
        if (px >= cuts[i] && px < cuts[i + 1]) return true;
      return false;
    },
  };
}

export function approved(scan?: BubbleScan) {
  return scan?.version === BUBBLE_VERSION &&
    scan.reviewed &&
    scan.status === "ready"
    ? scan.bubbles.filter((bubble) => bubble.decision === "approved")
    : [];
}

/** Separate shallow outline fragments from strokes entering the dialogue. */
export function boundaryInk(pixels: ArrayLike<number>, shape: ReturnType<typeof polygonRows>) {
  const { width, height, x, y } = shape;
  const dark = new Uint8Array(width * height);
  const rim = new Uint8Array(dark.length);
  const seeds: number[] = [];
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      const i = row * width + col, p = i * 4;
      const px = x + col, py = y + row;
      if (!shape.contains(px, py) || Math.min(pixels[p], pixels[p + 1], pixels[p + 2]) >= 145)
        continue;
      dark[i] = 1;
      if (!shape.contains(px - 1, py) || !shape.contains(px + 1, py) ||
          !shape.contains(px, py - 1) || !shape.contains(px, py + 1))
        seeds.push(i);
    }
  const reach = Math.min(8, Math.max(3, Math.floor(Math.min(width, height) / 8)));
  const offsets = [-reach, 0, reach];
  const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const seed of seeds) {
    if (!dark[seed]) continue;
    const component = [seed];
    dark[seed] = 0;
    let deepPixels = 0;
    for (const i of component) {
      const col = i % width, row = Math.floor(i / width);
      if (offsets.every(dy => offsets.every(dx => shape.contains(x + col + dx, y + row + dy))))
        deepPixels++;
      for (const [dx, dy] of neighbors) {
        if (col + dx < 0 || col + dx >= width || row + dy < 0 || row + dy >= height) continue;
        const neighbor = i + dy * width + dx;
        if (!dark[neighbor]) continue;
        dark[neighbor] = 0;
        component.push(neighbor);
      }
    }
    for (const i of component) rim[i] = 1;
    if (deepPixels >= 5) return { crossing: true, rim };
  }
  return { crossing: false, rim };
}
