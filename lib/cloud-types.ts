import type { Region } from "./api";

export type CloudPage = {
  id: string;
  project_id: string;
  position: number;
  name: string;
  width: number;
  height: number;
  status: string;
  error: string;
  revision: number;
  regions: Region[];
  metrics: Record<string, unknown>;
  uploaded: boolean;
  lease?: { token: string; until: number };
  tiles_done: number[];
  tile_count: number;
  translated: boolean;
  assets: Record<string, string>;
  garbage: string[];
};
export type CloudProject = {
  id: string;
  title: string;
  created: number;
  source: string;
  source_lang: string;
  target_lang: string;
  quality: string;
  style: string;
  provider: string;
  direction: string;
  last_page: number;
  cancelled: boolean;
  glossary: { source: string; target: string }[];
};
export type Document<T> = {
  id: string;
  owner: string;
  kind: string;
  project_id: string | null;
  data: T;
  version: number;
  expires_at: string;
};
export const CLOUD_LIMITS = {
  maxPages: 20,
  maxPixels: 12_000_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxImportBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 128 * 1024 * 1024,
  maxTiles: 12,
  maxRegions: 200,
  leaseMs: 5 * 60 * 1000,
} as const;
