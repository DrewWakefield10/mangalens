export const BOUNDARY = "Source lettering crosses the bubble boundary";
export const CLEANUP = "Original lettering could not be fully removed";
export const TOO_LONG = "Translation is too long to fit at a readable size";

export type PixelRun = [number, number, number];
export type LayoutDebug = Partial<
  Record<"source" | "placement" | "rejected", PixelRun[]> &
    Record<
      "source_truncated" | "placement_truncated" | "rejected_truncated",
      boolean
    >
>;
