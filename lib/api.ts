export type Page = {
  id: string;
  position: number;
  name: string;
  width: number;
  height: number;
  status: string;
  error: string;
  revision: number;
  original: string;
  translated: string;
  thumbnail: string;
  metrics: Record<string, unknown>;
};
export type Project = {
  execution_mode?: "browser";
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
  pages: Page[];
  ready: number;
  active: boolean;
};
export type Region = {
  id: string;
  page_id: string;
  box: number[];
  source_text: string;
  translation: string;
  language: string;
  confidence: number;
  orientation: string;
  kind: string;
  render: Record<string, unknown>;
  warnings: string[];
  restored: boolean;
};
export type Health = {
  execution_mode?: "browser";
  storage_configured?: boolean;
  max_pages?: number;
  status: string;
  providers: Record<string, boolean>;
  default_provider: string;
  cloud_ocr_available: boolean;
  cloud_ocr_provider: string;
  ocr_space_engine3_fallback: boolean;
  ocr_languages: string[];
  offline_pairs?: { source: string; target: string }[];
  offline_fallback_available?: boolean;
  font_available: boolean;
  retention_days: number;
  source_hosts: string[];
  max_upload_mb: number;
};
export type Usage = {
  providers: Record<string, { requests: number; characters: number; failures: number; rate_limits: number }>;
  deepl: {
    characters_submitted: number;
    local_characters_committed: number;
    requests: number;
    failures: number;
    rate_limits: number;
    local_monthly_budget: number;
    account?: { character_count: number; character_limit: number };
    account_error?: string;
  };
  cloud_ocr: { requests: number; failures: number; local_monthly_budget: number };
  ocr_space: {
    requests_today: number; requests_month: number; engine_2_requests: number;
    engine_3_requests: number; failures: number; rate_limits: number;
    daily_budget: number; monthly_budget: number; engine_3_monthly_budget: number;
  };
};
let session: Promise<unknown> | undefined;
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (path !== "/session" && path !== "/health") {
    session ||= api("/session", { method: "POST" }).catch((e) => {
      session = undefined;
      throw e;
    });
    await session;
  }
  const headers: Record<string, string> = { "X-MangaLens-Client": "web" };
  if (options.body && !(options.body instanceof FormData))
    headers["Content-Type"] = "application/json";
  const res = await fetch("/api" + path, {
    ...options,
    headers: { ...headers, ...options.headers },
    credentials: "same-origin",
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text).detail;
    } catch {}
    throw new Error(
      typeof message === "string" ? message : JSON.stringify(message),
    );
  }
  return res.json();
}
export const languages: Record<string, string> = {
  auto: "Detect automatically",
  ja: "Japanese",
  en: "English",
  ko: "Korean",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  ru: "Russian",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  tl: "Filipino",
};
export const ready = (p: Page) =>
  p.status === "completed" || p.status === "needs_review";
