import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { CloudPage, CloudProject, Document } from "./cloud-types";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
export function configured() {
  return Boolean(
    process.env.SUPABASE_URL && process.env.MANGALENS_GATEWAY_SECRET,
  );
}
export function uuid(value: string) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    fail(400, "Invalid resource ID.");
  return value;
}
export async function gateway<T>(input: Record<string, unknown>): Promise<T> {
  if (!configured())
    fail(
      503,
      "Cloud storage is not configured yet. Complete Supabase setup before importing pages.",
    );
  const base = process.env.SUPABASE_URL!.replace(/\/$/, "");
  const response = await fetch(base + "/functions/v1/mangalens-gateway", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.MANGALENS_GATEWAY_SECRET,
    },
    body: JSON.stringify(input),
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = String(data.message || data.detail || "");
    if (/budget|limit reached|Import between/.test(message)) fail(429, message);
    fail(
      response.status === 401 ? 503 : 502,
      "Cloud storage is unavailable. Retry shortly; your saved pages are preserved.",
    );
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}
export async function db<T>(
  table: string,
  method: string,
  query: Record<string, string> = {},
  body?: unknown,
) {
  return gateway<T[]>({ op: "db", table, method, query, body });
}
export async function owner(create = false) {
  const store = await cookies();
  let token = store.get("ml_cloud_session")?.value || "";
  if (!/^[a-f0-9]{64}$/.test(token)) token = "";
  if (token) {
    const id = createHash("sha256").update(token).digest("hex");
    const rows = await db<{ id: string }>("ml_sessions", "GET", {
      id: "eq." + id,
      expires_at: "gt." + new Date().toISOString(),
      select: "id",
    });
    if (rows.length) return id;
  }
  if (!create)
    fail(
      401,
      "Your private session expired. Reload the page to start a new session.",
    );
  token = randomBytes(32).toString("hex");
  const id = createHash("sha256").update(token).digest("hex");
  await gateway({
    op: "rpc",
    name: "ml_reserve_budget",
    body: { p_owner: id, p_kind: "session", p_amount: 1 },
  });
  await db("ml_sessions", "POST", {}, { id });
  store.set("ml_cloud_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 86400,
  });
  return id;
}
export async function document<T>(id: string, who: string, kind?: string) {
  const q: Record<string, string> = {
    id: "eq." + uuid(id),
    owner: "eq." + who,
    expires_at: "gt." + new Date().toISOString(),
  };
  if (kind) q.kind = "eq." + kind;
  const rows = await db<Document<T>>("ml_documents", "GET", q);
  return (
    rows[0] ||
    fail(404, "This chapter or page is unavailable in your browser session.")
  );
}
export async function list<T>(who: string, kind: string, project?: string) {
  const q: Record<string, string> = {
    owner: "eq." + who,
    kind: "eq." + kind,
    expires_at: "gt." + new Date().toISOString(),
    order: "id",
    limit: "100",
  };
  if (project) q.project_id = "eq." + uuid(project);
  return db<Document<T>>("ml_documents", "GET", q);
}
export async function mutate<T>(
  id: string,
  who: string,
  change: (data: T) => T,
  expected?: number,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await document<T>(id, who);
    if (expected !== undefined && doc.version !== expected)
      fail(409, "This page changed in another tab. Reload it before saving.");
    const value = change(structuredClone(doc.data));
    const rows = await db<Document<T>>(
      "ml_documents",
      "PATCH",
      { id: "eq." + doc.id, owner: "eq." + who, version: "eq." + doc.version },
      { data: value, version: doc.version + 1 },
    );
    if (rows.length) return rows[0];
  }
  return fail(409, "Another tab changed this page. Reload and try again.");
}
export function pathFor(
  who: string,
  page: string,
  kind: string,
  revision: string,
) {
  return who + "/" + uuid(page) + "/" + kind + "-" + revision + ".png";
}
export async function signed(path: string, upload = false) {
  const data = await gateway<{
    url?: string;
    signedURL?: string;
    signedUrl?: string;
  }>({ op: upload ? "upload" : "sign", path });
  const value = data.signedURL || data.signedUrl || data.url;
  if (!value) return fail(502, "Could not prepare image storage.");
  const base = process.env.SUPABASE_URL!.replace(/\/$/, "");
  const url = new URL(
    value.startsWith("/object/") ? "/storage/v1" + value : value,
    base,
  );
  if (url.origin !== new URL(base).origin)
    fail(502, "Invalid storage response.");
  return url.href;
}
export async function verifyPng(path: string, width: number, height: number) {
  const info = await gateway<{ header: number[]; size: number }>({
    op: "info",
    path,
  });
  const bytes = Buffer.from(info.header);
  if (
    info.size < 24 ||
    info.size > 8 * 1024 * 1024 ||
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  )
    fail(400, "The uploaded image is invalid or exceeds the page size limit.");
  return info;
}
export async function projectDto(doc: Document<CloudProject>, who: string) {
  const pages = (await list<CloudPage>(who, "page", doc.id)).map((p) =>
    pageDto(p.data),
  );
  pages.sort((a, b) => a.position - b.position);
  return {
    ...doc.data,
    execution_mode: "browser",
    pages,
    ready: pages.filter((p) => ["completed", "needs_review"].includes(p.status))
      .length,
    active: pages.some((p) =>
      ["queued", "processing", "rendering"].includes(p.status),
    ),
  };
}
export function pageDto(p: CloudPage) {
  const base = "/api/pages/" + p.id + "/image/";
  return {
    ...p,
    lease: undefined,
    assets: undefined,
    garbage: undefined,
    regions: undefined,
    original: base + "original",
    thumbnail: base + "thumbnail",
    translated: base + "translated?v=" + p.revision,
  };
}
export async function cleanup() {
  const expired = await db<Document<CloudPage>>("ml_documents", "GET", {
    kind: "eq.page",
    expires_at: "lt." + new Date().toISOString(),
    limit: "40",
  });
  for (const page of expired) {
    const paths = [...Object.values(page.data.assets), ...page.data.garbage];
    if (paths.length)
      await gateway({ op: "remove", paths: paths.slice(0, 100) });
    await db("ml_documents", "DELETE", { id: "eq." + page.id });
  }
  await db("ml_documents", "DELETE", {
    kind: "eq.project",
    expires_at: "lt." + new Date().toISOString(),
  });
}
