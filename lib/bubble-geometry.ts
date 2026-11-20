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
