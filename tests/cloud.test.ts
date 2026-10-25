import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { parseOcr, overlap } from "../lib/cloud-providers";
import {
  document,
  mutate,
  signed,
  verifyPng,
  HttpError,
} from "../lib/cloud-store";

let pg: PGlite;
before(async () => {
  pg = new PGlite();
  await pg.exec(
    "create role anon; create role authenticated; create role service_role; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  await pg.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202610260001_browser_processing.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
after(async () => {
  await pg.close();
});
test("SQL denies anonymous direct access and RPC budget bypass", async () => {
  await assert.rejects(
    pg.exec("set role anon; select * from public.ml_documents;"),
    /permission denied/,
  );
  await pg.exec("reset role");
  await assert.rejects(
    pg.exec("set role anon; select public.ml_reserve_budget('x','ocr',1,3);"),
    /permission denied/,
  );
  await pg.exec("reset role");
});
test("OCR budgets apply across sessions and include attempted calls", async () => {
  await pg.exec("truncate public.ml_usage");
  for (let i = 0; i < 50; i++)
    await pg.query("select public.ml_reserve_budget($1,'ocr',1,3)", [
      "owner-" + i,
    ]);
  await assert.rejects(
    pg.query("select public.ml_reserve_budget('new-session','ocr',1,3)"),
    /budget reached/,
  );
  const data = await pg.query<{ count: number }>(
    "select count(*)::int as count from public.ml_usage",
  );
  assert.equal(data.rows[0].count, 50);
});
test("DeepL budget cannot be reset by another browser session", async () => {
  await pg.exec("truncate public.ml_usage");
  for (let i = 0; i < 4; i++)
    await pg.query("select public.ml_reserve_budget($1,'deepl',25000,0)", [
      "owner-" + i,
    ]);
  await assert.rejects(
    pg.query("select public.ml_reserve_budget('other','deepl',1,0)"),
    /character budget reached/,
  );
});
test("storage capacity is global and page creation checks project ownership", async () => {
  const owner = "a".repeat(64),
    other = "b".repeat(64),
    id = "00000000-0000-4000-8000-000000000001";
  await pg.query("insert into ml_sessions(id) values($1),($2)", [owner, other]);
  await pg.query(
    "insert into ml_documents(id,owner,kind,data) values($1,$2,'project','{}')",
    [id, owner],
  );
  await assert.rejects(
    pg.query("select ml_create_pages($1,$2,$3)", [
      other,
      id,
      JSON.stringify([{ id: "00000000-0000-4000-8000-000000000002" }]),
    ]),
    /Project not found/,
  );
  const pages = Array.from({ length: 20 }, (_, i) => ({
    id: "10000000-0000-4000-8000-" + String(i).padStart(12, "0"),
  }));
  await pg.query("select ml_create_pages($1,$2,$3)", [
    owner,
    id,
    JSON.stringify(pages),
  ]);
  await assert.rejects(
    pg.query("select ml_create_pages($1,$2,$3)", [
      owner,
      id,
      JSON.stringify([{ id: "20000000-0000-4000-8000-000000000001" }]),
    ]),
    /storage page limit/,
  );
});
test("OCR uses real coordinates, flags missing confidence, and clips invalid words", () => {
  const regions = parseOcr(
    {
      OCRExitCode: 1,
      ParsedResults: [
        {
          FileParseExitCode: 1,
          TextOverlay: {
            Lines: [
              {
                LineText: "Hello",
                Words: [{ Left: 10, Top: 20, Width: 40, Height: 15 }],
              },
            ],
          },
        },
      ],
    },
    { index: 0, count: 1, x: 100, y: 200, width: 400, height: 400, base64: "" },
    "page",
    "en",
  );
  assert.deepEqual(regions[0].box, [110, 220, 40, 15]);
  assert.equal(regions[0].confidence, 0);
  assert.match(regions[0].warnings[0], /no confidence/);
  assert.equal(overlap([0, 0, 100, 100], [50, 0, 100, 100]), 0.5);
});
test("OCR failure is not reported as an empty successful page", () => {
  assert.throws(
    () =>
      parseOcr(
        { OCRExitCode: 3, IsErroredOnProcessing: true },
        { index: 0, count: 1, x: 0, y: 0, width: 10, height: 10, base64: "" },
        "page",
        "ja",
      ),
    /could not recognize/,
  );
});
test("document ownership, optimistic conflicts, signed origin and PNG verification", async () => {
  const original = global.fetch;
  process.env.SUPABASE_URL = "https://storage.example.test";
  process.env.MANGALENS_GATEWAY_SECRET = "test-only";
  const id = "00000000-0000-4000-8000-000000000003";
  let doc = {
    id,
    owner: "owner-a",
    kind: "page",
    version: 1,
    data: { value: 1 },
  };
  let spoof = false;
  global.fetch = async (_url, input) => {
    const request = JSON.parse(String(input?.body));
    if (request.op === "db") {
      if (request.query.owner !== "eq.owner-a") return Response.json([]);
      if (request.method === "GET")
        return Response.json([structuredClone(doc)]);
      if (request.method === "PATCH") {
        if (request.query.version !== "eq." + doc.version)
          return Response.json([]);
        doc = { ...doc, ...request.body };
        return Response.json([structuredClone(doc)]);
      }
    }
    if (request.op === "sign")
      return Response.json({
        signedURL: spoof
          ? "https://attacker.test/image"
          : "/object/sign/mangalens/test.png?token=abc",
      });
    if (request.op === "info") {
      const header = Buffer.alloc(32);
      Buffer.from("89504e470d0a1a0a", "hex").copy(header);
      header.writeUInt32BE(640, 16);
      header.writeUInt32BE(480, 20);
      return Response.json({ header: Array.from(header), size: 1000 });
    }
    throw new Error("Unexpected request");
  };
  try {
    await assert.rejects(
      document(id, "owner-b"),
      (e: unknown) => e instanceof HttpError && e.status === 404,
    );
    const updated = await mutate<{ value: number }>(
      id,
      "owner-a",
      (p) => ({ value: p.value + 1 }),
      1,
    );
    assert.equal(updated.data.value, 2);
    await assert.rejects(
      mutate(id, "owner-a", (p) => p, 1),
      (e: unknown) => e instanceof HttpError && e.status === 409,
    );
    assert.match(
      await signed("path"),
      /^https:\/\/storage.example.test\/storage\/v1\/object\/sign\//,
    );
    spoof = true;
    await assert.rejects(signed("path"), /Invalid storage response/);
    await verifyPng("path", 640, 480);
    await assert.rejects(
      verifyPng("path", 641, 480),
      /uploaded image is invalid/,
    );
  } finally {
    global.fetch = original;
    delete process.env.SUPABASE_URL;
    delete process.env.MANGALENS_GATEWAY_SECRET;
  }
});

import {
  layoutGroups,
  prepareRegions,
  bubbleInk,
  speechMap,
} from "../lib/page-layout";
import type { Region } from "../lib/api";
function rasterFixture() {
  const width = 600,
    height = 400,
    data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x: number, y: number, w: number, h: number, value = 0) => {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const p = (yy * width + xx) * 4;
        data[p] = data[p + 1] = data[p + 2] = value;
      }
  };
  for (const x of [20, 220]) {
    paint(x, 20, 160, 3);
    paint(x, 217, 160, 3);
    paint(x, 20, 3, 200);
    paint(x + 157, 20, 3, 200);
  }
  for (const x of [65, 115])
    for (let y = 60; y < 140; y += 25) paint(x, y, 12, 16);
  paint(250, 60, 14, 16);
  const region = (id: string, x: number, text: string): Region => ({
    id,
    page_id: "page",
    box: [x, 58, 14, 90],
    source_text: text,
    translation: "",
    language: "ja",
    confidence: 0,
    orientation: "vertical",
    kind: "cloud_text",
    render: { words: [[x, 58, 14, 90]], source_box: [x, 58, 14, 90] },
    warnings: [],
    restored: false,
  });
  return { image: { width, height, data }, region, paint };
}
test("vertical dialogue joins right-to-left within its balloon and expands placement", () => {
  const { image, region } = rasterFixture();
  const regions = [region("left", 65, "です"), region("right", 115, "今日")];
  const prepared = prepareRegions(regions, layoutGroups(image, regions));
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].source_text, "今日です");
  assert.equal(prepared[0].orientation, "vertical");
  assert.ok(prepared[0].box[2] > 100);
  assert.equal((prepared[0].render.source_members as unknown[]).length, 2);
});
test("separate balloons and manual corrections are never merged", () => {
  const { image, region } = rasterFixture();
  const a = region("a", 65, "今日"),
    b = region("b", 250, "明日");
  assert.equal(layoutGroups(image, [a, b]).length, 2);
  const edited = {
    ...region("edit", 115, "直しました"),
    translation: "My correction",
    render: { ...a.render, user_edited: true },
  };
  const prepared = prepareRegions(
    [a, edited],
    layoutGroups(image, [a, edited]),
  );
  assert.equal(prepared.length, 2);
  assert.equal(
    prepared.find((r) => r.id === "edit")!.translation,
    "My correction",
  );
  assert.deepEqual(prepared.find((r) => r.id === "edit")!.box, edited.box);
});
test("cleanup finds lettering beyond approximate OCR boxes while preserving outlines", () => {
  const { image, region } = rasterFixture();
  const groups = layoutGroups(image, [region("a", 65, "今日")]);
  const ink = bubbleInk(image, speechMap(image), groups[0].bubble!);
  assert.ok(ink.includes(65 + 60 * image.width));
  assert.ok(
    ink.includes(115 + 110 * image.width),
    "unboxed lettering inside the same balloon is included",
  );
  assert.ok(
    !ink.includes(20 + 100 * image.width),
    "balloon outline must remain",
  );
  assert.ok(
    !ink.includes(250 + 60 * image.width),
    "another balloon must remain",
  );
});
test("provider paragraph order is retained when approximate vertical boxes disagree", () => {
  const { image, region } = rasterFixture();
  const a = region("a", 65, "先に"),
    b = region("b", 115, "次に");
  a.render = { ...a.render, ocr_paragraph: "0:1", ocr_order: 1 };
  b.render = { ...b.render, ocr_paragraph: "0:1", ocr_order: 2 };
  assert.equal(
    prepareRegions([a, b], layoutGroups(image, [a, b]))[0].source_text,
    "先に次に",
  );
});
