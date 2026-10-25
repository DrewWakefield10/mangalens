// This function holds Supabase's built-in service-role credential inside Supabase.
// A random Vercel-only bearer token authenticates calls; only its SHA-256 is
// substituted at deployment. Never replace this marker with the bearer token.
const GATEWAY_HASH = "__MANGALENS_GATEWAY_HASH__";
const tables = new Set(["ml_sessions", "ml_documents", "ml_usage"]);
const functions = new Set(["ml_reserve_budget", "ml_create_pages"]);
const bucket = "mangalens";

Deno.serve(async (request: Request) => {
  try {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))))
      .map((v) => v.toString(16).padStart(2,"0")).join("");
    if (!token || hash !== GATEWAY_HASH) return Response.json({ detail: "Unauthorized" }, { status: 401 });
    const raw = await request.text();
    if (raw.length > 2_000_000) return Response.json({ detail: "Request too large" }, { status: 413 });
    const input = JSON.parse(raw);
    const origin = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const headers: Record<string,string> = { apikey: key, authorization: "Bearer " + key, "content-type": "application/json" };
    let path = ""; let method = "POST"; let body: unknown = input.body;
    const validPath = (p: unknown) => typeof p === "string" && /^[a-f0-9]{64}\/[a-f0-9-]{36}\/(original|thumbnail|translated|clean|mask)-[a-f0-9-]+\.png$/.test(p);
    if (input.op === "db" && tables.has(input.table) && ["GET","POST","PATCH","DELETE"].includes(input.method)) {
      path = "/rest/v1/" + input.table + "?" + new URLSearchParams(input.query || {}).toString();
      method = input.method; headers.prefer = "return=representation";
    } else if (input.op === "rpc" && functions.has(input.name)) {
      path = "/rest/v1/rpc/" + input.name;
    } else if (["upload","sign","info"].includes(input.op) && validPath(input.path)) {
      const suffix = bucket + "/" + input.path;
      if (input.op === "upload") { path = "/storage/v1/object/upload/sign/" + suffix; body = { upsert: true }; }
      if (input.op === "sign") { path = "/storage/v1/object/sign/" + suffix; body = { expiresIn: 600 }; }
      if (input.op === "info") {
        path = "/storage/v1/object/authenticated/" + suffix;
        method = "GET"; headers.range = "bytes=0-31"; body = undefined;
      }
    } else if (input.op === "remove" && Array.isArray(input.paths) && input.paths.length <= 100 && input.paths.every(validPath)) {
      path = "/storage/v1/object/" + bucket; method = "DELETE"; body = { prefixes: input.paths };
    } else return Response.json({ detail: "Unsupported operation" }, { status: 400 });
    const response = await fetch(origin + path, { method, headers,
      body: ["GET","HEAD"].includes(method) ? undefined : JSON.stringify(body) });
    if (input.op === "info" && response.ok) {
      // Cancel after the PNG header; do not download an entire image in this gateway.
      const reader = response.body!.getReader(); const first = await reader.read(); await reader.cancel();
      const bytes = first.value?.slice(0,32) || new Uint8Array();
      const size = Number(response.headers.get("content-range")?.split("/")[1] || response.headers.get("content-length") || 0);
      return Response.json({ header: Array.from(bytes), size });
    }
    return new Response(response.status === 204 ? null : await response.text(), { status: response.status,
      headers: { "content-type":"application/json", "cache-control":"no-store" } });
  } catch {
    return Response.json({ detail: "Storage gateway request failed" }, { status: 502 });
  }
});
