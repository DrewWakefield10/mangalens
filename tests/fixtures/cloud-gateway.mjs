// Test double for Supabase storage/PostgREST. This is never deployed.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
const tables = { ml_sessions: [], ml_documents: [], ml_usage: [] };
const assets = new Map();
const now = () => new Date().toISOString();
function match(row, q) {
  for (const [key, condition] of Object.entries(q || {})) {
    if (["select", "limit", "order"].includes(key)) continue;
    if (key === "data->regions") {
      const id = JSON.parse(condition.slice(3))[0].id;
      if (!row.data.regions.some((r) => r.id === id)) return false;
      continue;
    }
    const value = row[key],
      split = condition.indexOf("."),
      op = condition.slice(0, split),
      want = condition.slice(split + 1);
    if (op === "eq" && String(value) !== want) return false;
    if (op === "gt" && String(value) <= want) return false;
    if (op === "gte" && String(value) < want) return false;
    if (op === "lt" && String(value) >= want) return false;
  }
  return true;
}
function send(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}
const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "PUT,GET,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-upsert",
    });
    res.end();
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  let chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (url.pathname.startsWith("/upload/") && req.method === "PUT") {
    assets.set(decodeURIComponent(url.pathname.slice(8)), bytes);
    send(res, { ok: true });
    return;
  }
  if (url.pathname.startsWith("/asset/")) {
    const blob = assets.get(decodeURIComponent(url.pathname.slice(7)));
    if (!blob) {
      send(res, {}, 404);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(blob);
    return;
  }
  if (url.pathname === "/fixture/state") {
    send(res, tables);
    return;
  }
  if (url.pathname === "/fixture/expire") {
    for (const p of tables.ml_documents)
      if (p.data.lease) p.data.lease.until = 0;
    send(res, { ok: true });
    return;
  }
  if (url.pathname !== "/functions/v1/mangalens-gateway") {
    send(res, {}, 404);
    return;
  }
  const input = JSON.parse(bytes.toString() || "{}");
  if (req.headers.authorization !== "Bearer fixture-secret") {
    send(res, { detail: "Unauthorized" }, 401);
    return;
  }
  const base = "http://127.0.0.1:" + server.address().port;
  if (input.op === "upload") {
    send(res, { url: base + "/upload/" + encodeURIComponent(input.path) });
    return;
  }
  if (input.op === "sign") {
    send(res, { signedURL: base + "/asset/" + encodeURIComponent(input.path) });
    return;
  }
  if (input.op === "info") {
    const data = assets.get(input.path);
    send(
      res,
      data
        ? { header: Array.from(data.subarray(0, 32)), size: data.length }
        : { detail: "Not found" },
      data ? 200 : 404,
    );
    return;
  }
  if (input.op === "remove") {
    for (const path of input.paths) assets.delete(path);
    send(res, []);
    return;
  }
  if (input.op === "rpc") {
    if (input.name === "ml_reserve_budget") {
      tables.ml_usage.push({
        ...input.body,
        owner: input.body.p_owner,
        kind: input.body.p_kind,
        amount: input.body.p_amount,
        engine: input.body.p_engine || 0,
        created_at: now(),
      });
      send(res, null);
      return;
    }
    if (input.name === "ml_create_pages") {
      for (const p of input.body.p_pages) {
        // The fixture supplies recognized/translated text so browser render/storage can
        // be tested without making live provider requests or consuming real quota.
        p.regions = [
          {
            id: randomUUID(),
            page_id: p.id,
            box: [110, 150, 260, 130],
            source_text: "Hello!",
            translation: "A new chapter",
            language: "en",
            confidence: 0,
            orientation: "horizontal",
            kind: "cloud_text",
            render: {
              words: [[140, 170, 180, 70]],
              source_box: [110, 150, 260, 130],
              source_verified: false,
            },
            warnings: ["Review cloud OCR"],
            restored: false,
          },
        ];
        p.translated = true;
        p.tiles_done = [0];
        p.tile_count = 1;
        tables.ml_documents.push({
          id: p.id,
          owner: input.body.p_owner,
          kind: "page",
          project_id: input.body.p_project,
          data: p,
          version: 1,
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        });
      }
      send(res, null);
      return;
    }
  }
  if (input.op === "db") {
    const rows = tables[input.table];
    if (!rows) {
      send(res, {}, 400);
      return;
    }
    if (input.method === "GET") {
      send(
        res,
        rows
          .filter((r) => match(r, input.query))
          .map((r) => structuredClone(r)),
      );
      return;
    }
    if (input.method === "POST") {
      const row = {
        created_at: now(),
        expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        version: 1,
        ...input.body,
      };
      rows.push(row);
      send(res, [row]);
      return;
    }
    if (input.method === "PATCH") {
      const matches = rows.filter((r) => match(r, input.query));
      for (const row of matches) Object.assign(row, input.body);
      send(res, matches);
      return;
    }
    if (input.method === "DELETE") {
      const removed = rows.filter((r) => match(r, input.query));
      tables[input.table] = rows.filter((r) => !removed.includes(r));
      if (input.table === "ml_documents") {
        const ids = new Set(removed.map((r) => r.id));
        tables.ml_documents = tables.ml_documents.filter(
          (r) => !ids.has(r.project_id),
        );
      }
      send(res, removed);
      return;
    }
  }
  send(res, { detail: "Unsupported fixture operation" }, 400);
});
server.listen(Number(process.env.CLOUD_FIXTURE_PORT || 4400), "127.0.0.1", () =>
  console.log("Cloud fixture listening on " + server.address().port),
);
