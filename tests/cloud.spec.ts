import { test, expect } from "@playwright/test";
test.skip(
  process.env.CLOUD_BROWSER_TEST !== "1",
  "Run with npm run test:cloud-browser; uses a test double for storage and recognized text.",
);
test("browser import, rendering, private ownership, editor save, exports and deletion", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/translate");
  await expect(
    page.getByText("Up to 20 pages", { exact: false }),
  ).toBeVisible();
  const source = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 1100;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 800, 1100);
    ctx.strokeStyle = "black";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.ellipse(215, 197, 140, 90, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "red";
    ctx.fillRect(85, 116, 14, 14);
    ctx.fillText("OUTSIDE", 490, 220);
    ctx.fillStyle = "black";
    ctx.font = "36px Arial";
    ctx.fillText("Hello!", 145, 215);
    return Array.from(
      new Uint8Array(
        await (await fetch(canvas.toDataURL("image/png"))).arrayBuffer(),
      ),
    );
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "chapter-01.png",
    mimeType: "image/png",
    buffer: Buffer.from(source),
  });
  await page.getByLabel("I have permission to upload").check();
  await page.getByRole("button", { name: "Preview chapter" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText(/^1 pages ·/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Translate Chapter" })).toBeDisabled();
  await expect(page.locator(".bubble-outline.approved")).toHaveCount(1);
  await page.getByRole("button", { name: "Save page selection" }).click();
  await page.getByRole("button", { name: "Translate Chapter" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]+/);
  const id = page.url().split("/").pop()!;
  await expect(
    page.getByText("Pages are ready for review", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({
    path: "test-results/cloud-desktop.png",
    fullPage: true,
  });
  const response = await page.evaluate(async (id) => {
    const r = await fetch("/api/projects/" + id);
    return { status: r.status, data: await r.json() };
  }, id);
  expect(response.status).toBe(200);
  expect(response.data.pages[0].status).toBe("needs_review");
  const pageId = response.data.pages[0].id;
  const second = await browser.newContext();
  const other = await second.newPage();
  await other.goto("/projects");
  const unauthorized = await other.evaluate(async (id) => {
    await fetch("/api/session", {
      method: "POST",
      headers: { "X-MangaLens-Client": "web" },
    });
    return (await fetch("/api/projects/" + id)).status;
  }, id);
  expect(unauthorized).toBe(404);
  await second.close();
  await page.getByLabel("I have permission to export").check();
  for (const format of ["CBZ", "PDF"]) {
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: format, exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(
      new RegExp("\\." + format.toLowerCase() + "$"),
    );
  }
  await page.goto("/editor/" + id);
  await expect(
    page.getByRole("textbox", { name: "Recognized source", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const usageCount = async () => {
    const state = await page.request.get("http://127.0.0.1:4401/fixture/state");
    return (await state.json()).ml_usage.length;
  };
  const usageBefore = await usageCount();
  await page.getByLabel("Inspection overlay").selectOption("boundary");
  await expect(page.getByRole("img", { name: "Bubble boundary" })).toBeVisible();
  await page.getByRole("button", { name: "Edit Translation", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Translation", exact: true })).toBeFocused();
  await page
    .getByRole("textbox", { name: "Translation", exact: true })
    .fill("The next\nadventure");
  await page.getByRole("button", { name: "Auto-Fit Text", exact: true }).click();
  await expect(
    page.getByText("Saved. This bubble is being rendered again.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/projects/" + id);
  await expect(
    page.getByText("Pages are ready for review", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  expect(await usageCount()).toBe(usageBefore);
  const rerendered = await (await page.request.get("/api/pages/" + pageId + "/regions")).json();
  expect(rerendered[0].translation).toBe("The next\nadventure");
  expect(rerendered[0].render.layout_debug.placement.length).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/cloud-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep chapter", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete chapter", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(
    page.getByText("A story is waiting for you.", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("API rejects foreign origins, competing claims and stale processing tokens", async ({
  request,
}) => {
  const headers = { "X-MangaLens-Client": "web" };
  const blocked = await request.post("/api/session", {
    headers: { ...headers, Origin: "https://untrusted.example" },
  });
  expect(blocked.status()).toBe(403);
  expect((await request.post("/api/session", { headers })).ok()).toBeTruthy();
  const created = await request.post("/api/projects", {
    headers,
    data: { authorized: true, title: "Lease regression" },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const { default: sharp } = await import("sharp");
  const png = await sharp(Buffer.from(
    '<svg width="256" height="256"><rect width="256" height="256" fill="white"/><ellipse cx="120" cy="124" rx="70" ry="46" fill="white" stroke="black" stroke-width="5"/><path d="M98 114h10v15H98z M114 114h10v15H114z M130 114h10v15H130z"/></svg>',
  )).png().toBuffer();
  const imported = await request.post(
    "/api/projects/" + project.id + "/pages",
    {
      headers,
      data: {
        pages: [{ name: "one.png", width: 256, height: 256, bytes: png.length }],
      },
    },
  );
  expect(imported.status()).toBe(201);
  const [asset] = await imported.json();
  for (const kind of ["original", "thumbnail"])
    expect(
      (
        await request.put(asset[kind], {
          headers: { "Content-Type": "image/png" },
          data: png,
        })
      ).ok(),
    ).toBeTruthy();
  expect(
    (
      await request.post("/api/pages/" + asset.id + "/uploaded", { headers })
    ).ok(),
  ).toBeTruthy();
  const start = () =>
    request.post("/api/projects/" + project.id + "/start", {
      headers,
      data: { source_lang: "ja", target_lang: "en", provider: "deepl" },
    });
  expect((await start()).status()).toBe(409);
  expect((await request.post("/api/projects/" + project.id + "/bubble-scans", { headers, data: {} })).ok()).toBeTruthy();
  const scanUrl = "/api/pages/" + asset.id + "/bubbles";
  const scan = await (await request.get(scanUrl)).json();
  expect(scan.status).toBe("ready");
  expect(scan.bubbles).toHaveLength(1);
  scan.bubbles[0].decision = "approved";
  scan.bubbles[0].confirmed = true;
  expect((await request.put(scanUrl, { headers, data: { revision: scan.revision, bubbles: scan.bubbles } })).ok()).toBeTruthy();
  expect((await start()).ok()).toBeTruthy();
  const claims = await Promise.all(
    [1, 2].map(() =>
      request.post("/api/projects/" + project.id + "/claim", { headers }),
    ),
  );
  const values = await Promise.all(claims.map((r) => r.json()));
  expect(values.filter(Boolean)).toHaveLength(1);
  const first = values.find(Boolean);
  expect(
    (await request.delete("/api/projects/" + project.id, { headers })).status(),
  ).toBe(409);
  expect(
    (
      await request.post("/api/projects/" + project.id + "/cancel", { headers })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.post("/api/pages/" + asset.id + "/output-urls", {
        headers,
        data: { token: first.token },
      })
    ).status(),
  ).toBe(409);
  expect((await start()).ok()).toBeTruthy();
  const second = await (
    await request.post("/api/projects/" + project.id + "/claim", { headers })
  ).json();
  expect(second.token).not.toBe(first.token);
  expect((await request.post("/api/pages/" + asset.id + "/recognize", {
    headers, data: { token: second.token, index: 0 },
  })).ok()).toBeTruthy();
  const [region] = await (await request.get("/api/pages/" + asset.id + "/regions")).json();
  expect(region.source_text).toBe("Hello!");
  expect(
    (
      await request.post("/api/pages/" + asset.id + "/failed", {
        headers,
        data: { token: second.token, message: "Interrupted fixture request" },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.put("/api/regions/" + region.id, {
        headers,
        data: { page_version: 1 },
      })
    ).status(),
  ).toBe(409);

  const [saved] = await (
    await request.get("/api/pages/" + asset.id + "/regions")
  ).json();
  const edited = await request.put("/api/regions/" + region.id, {
    headers,
    data: {
      page_version: saved.render.page_version,
      source_text: "Saved correction",
      translation: "Keep my translation",
      language: "ja",
      box: region.box,
      source_box: region.render.source_box,
      font_size: 42,
      align: "center",
      offset_x: 0,
      offset_y: 0,
      source_verified: true,
      restored: false,
      mask_include: [],
      mask_exclude: [],
      mask_dilation: 1,
    },
  });
  expect(edited.ok()).toBeTruthy();
  expect(
    (
      await request.post("/api/projects/" + project.id + "/cancel", { headers })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.post("/api/pages/" + asset.id + "/ocr", {
        headers,
        data: { source_lang: "ja" },
      })
    ).ok(),
  ).toBeTruthy();
  const retry = await (
    await request.post("/api/projects/" + project.id + "/claim", { headers })
  ).json();
  expect(retry.page.regions).toHaveLength(1);
  expect(retry.page.regions[0].source_text).toBe("Saved correction");
  expect(retry.page.regions[0].translation).toBe("Keep my translation");
  expect(retry.page.tiles_done).toEqual([0]);
  expect(retry.page.metrics.ocr_language).toBe("ja");
  expect((await request.post("/api/pages/" + asset.id + "/prepare", {
    headers, data: { token: retry.token, groups: [{ ids: [region.id], box: [0, 0, 256, 256] }] },
  })).status()).toBe(409);
  expect(
    (
      await request.post("/api/pages/" + asset.id + "/translate", {
        headers,
        data: { token: retry.token },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.post("/api/pages/" + asset.id + "/failed", {
        headers,
        data: { token: retry.token, message: "Fixture finished" },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (await request.delete("/api/projects/" + project.id, { headers })).ok(),
  ).toBeTruthy();
});

test("import waits for service discovery before choosing an upload route", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/health", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/translate", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"]').setInputFiles({
    name: "test.png",
    mimeType: "image/png",
    buffer: Buffer.from("fixture"),
  });
  await page.getByLabel("I have permission to upload").check();
  await expect(
    page.getByRole("button", { name: "Connecting services" }),
  ).toBeDisabled();
  release();
  await expect(
    page.getByRole("button", { name: "Preview chapter" }),
  ).toBeEnabled();
  await expect(
    page.getByText("Up to 20 pages", { exact: false }),
  ).toBeVisible();
});

test("vertical balloon rendering removes old lettering and preserves the outline", async ({
  page,
}) => {
  const { build } = await import("esbuild");
  const bundle = await build({
    stdin: {
      contents:
        'export {renderPage} from "./lib/browser-render"; export {layoutGroups,prepareRegions} from "./lib/page-layout";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "MangaLensRenderTest",
    platform: "browser",
    target: "es2020",
  });
  await page.goto("/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const module = (
      window as unknown as {
        MangaLensRenderTest: typeof import("../lib/browser-render") &
          typeof import("../lib/page-layout");
      }
    ).MangaLensRenderTest;
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#999";
    ctx.fillRect(0, 0, 800, 600);
    ctx.fillStyle = "white";
    ctx.strokeStyle = "black";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(250, 210, 110, 165, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "black";
    for (const x of [230, 280])
      for (let y = 110; y < 230; y += 30) ctx.fillRect(x, y, 14, 20);
    const region = (id: string, x: number, text: string, order: number) => ({
      id,
      page_id: "fixture",
      box: [x, 110, 14, 110],
      source_text: text,
      translation: "",
      language: "ja",
      confidence: 0,
      orientation: "vertical",
      kind: "cloud_text",
      render: {
        source_box: [x, 110, 14, 110],
        words: [[x, 110, 14, 110]],
        ocr_paragraph: "one",
        ocr_order: order,
      },
      warnings: [],
      restored: false,
    });
    const raw = [
      region("right", 280, "こんにちは", 0),
      region("left", 230, "また明日", 1),
    ];
    const groups = module.layoutGroups(ctx.getImageData(0, 0, 800, 600), raw);
    const prepared = module.prepareRegions(raw, groups);
    prepared[0].translation = "Hello there. See you again tomorrow!";
    const bitmap = await createImageBitmap(canvas);
    const rendered = await module.renderPage(
      bitmap,
      { width: 500, height: 420 } as import("../lib/cloud-types").CloudPage,
      prepared,
    );
    bitmap.close();
    const clean = await createImageBitmap(rendered.clean);
    ctx.clearRect(0, 0, 500, 420);
    ctx.drawImage(clean, 0, 0);
    clean.close();
    const pixel = (x: number, y: number) =>
      Array.from(ctx.getImageData(x, y, 1, 1).data);
    return {
      groups: prepared.length,
      source: prepared[0].source_text,
      cleared: pixel(284, 115),
      outline: pixel(140, 210),
      outside: pixel(10, 10),
      diagnostics: rendered.diagnostics,
    };
  });
  expect(result.groups).toBe(1);
  expect(result.source).toBe("こんにちはまた明日");
  expect(result.cleared.slice(0, 3)).toEqual([255, 255, 255]);
  expect(result.outline[0]).toBeLessThan(100);
  expect(result.outside.slice(0, 3)).toEqual([153, 153, 153]);
  expect(result.diagnostics[0].status).toBe("RENDERED_NEEDS_REVIEW");
  expect(result.diagnostics[0].mask_pixels).toBeGreaterThan(1000);
  expect(result.diagnostics[0].font_size).toBeGreaterThanOrEqual(12);
});

test("approved jagged bubbles use separate cleanup and fit checks and isolate a layout edit", async ({ page }) => {
  const { build } = await import("esbuild");
  const bundle = await build({
    stdin: {
      contents: 'export {renderPage} from "./lib/browser-render"; export {polygonRows} from "./lib/bubble-geometry";',
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, format: "iife", globalName: "MangaLensRenderTest",
    platform: "browser", target: "es2020",
  });
  await page.goto("/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Point = import("../lib/bubble-geometry").Point;
    type Region = import("../lib/api").Region;
    const { renderPage, polygonRows } = (window as unknown as {
      MangaLensRenderTest: typeof import("../lib/browser-render") & typeof import("../lib/bubble-geometry");
    }).MangaLensRenderTest;
    const canvas = document.createElement("canvas");
    const width = canvas.width = 580, height = canvas.height = 330;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#a0a1a2";
    ctx.fillRect(0, 0, width, height);
    const shapes: Point[][] = [
      [[36,45],[176,45],[225,80],[232,201],[181,223],[84,221],[65,246],[60,219],[36,197]],
      [[282,45],[425,45],[425,217],[282,217]],
    ];
    for (const points of shapes) {
      ctx.beginPath();
      for (const [x,y] of points) ctx.lineTo(x,y);
      ctx.closePath();
      ctx.fillStyle = "white";
      ctx.strokeStyle = "#222";
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = "#262626";
    ctx.font = "24px sans-serif";
    ctx.fillText("じゃ！", 43, 122);
    ctx.fillText("またね", 327, 125);
    ctx.fillStyle = "#d00";
    ctx.fillText("OUTSIDE", 460, 145);
    const regions: Region[] = shapes.map((shape, index) => {
      const source = index === 0 ? [42, 99, 77, 31] : [325, 102, 79, 29];
      return {
        id: String(index), page_id: "fixture", box: source, language: "ja",
        orientation: "horizontal", source_text: index === 0 ? "じゃ！" : "またね",
        confidence: 1, translation: index === 0 ? "Ça y est!\nSee you tomorrow, then." : "W".repeat(120),
        restored: false, warnings: [], kind: "speech_bubble",
        render: { bubble_polygon: shape, source_box: source, source_verified: true },
      };
    });
    const page = { width, height, regions } as import("../lib/cloud-types").CloudPage;
    const original = ctx.getImageData(0, 0, width, height).data;
    const bitmap = await createImageBitmap(canvas);
    const first = await renderPage(bitmap, page, regions);
    const saved = {
      translated: await createImageBitmap(first.translated),
      clean: await createImageBitmap(first.clean),
      mask: await createImageBitmap(first.mask),
    };
    const read = (image: ImageBitmap) => {
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, width, height).data;
    };
    const clean = read(saved.clean), translated = read(saved.translated);
    const scope = polygonRows(shapes[0]);
    const placement = first.diagnostics[0].layout_debug?.placement ?? [];
    let unchangedOutside = true, sourceRemoved = 0, placed = 0, clipped = false;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (!scope.contains(x, y) && (clean[i] !== original[i] || translated[i] !== original[i]))
          unchangedOutside = false;
        if (x >= 42 && x < 119 && y >= 99 && y < 130 && original[i] < 255 && clean[i] === 255)
          sourceRemoved++;
        if (translated[i] === clean[i]) continue;
        placed++;
        if (!placement.some(([left, row, w]) => y === row && x >= left && x < left + w)) clipped = true;
      }
    regions[1].translation = "พรุ่งนี้เราจะกลับมาเจอกันที่ห้องเรียน!";
    const edited = await renderPage(bitmap, page, [regions[1]], saved);
    const updatedImage = await createImageBitmap(edited.translated);
    const updated = read(updatedImage);
    const other = polygonRows(shapes[1]);
    let preservedPrevious = true, editedPixels = 0;
    for (let i = 0; i < updated.length; i += 4)
      if (updated[i] !== translated[i]) {
        const index = i / 4;
        if (!other.contains(index % width, Math.floor(index / width))) preservedPrevious = false;
        else editedPixels++;
      }
    for (const image of [bitmap, updatedImage, ...Object.values(saved)]) image.close();
    return { unchangedOutside, sourceRemoved, placed, clipped, preservedPrevious, editedPixels,
      diagnostics: first.diagnostics, edited: edited.diagnostics };
  });
  expect(result.unchangedOutside).toBe(true);
  expect(result.sourceRemoved).toBeGreaterThan(80);
  expect(result.placed).toBeGreaterThan(80);
  expect(result.clipped).toBe(false);
  expect(result.diagnostics[0].font_size).toBeGreaterThanOrEqual(12);
  expect(result.diagnostics[1].reason).toBe("Translation is too long to fit at a readable size");
  expect(result.preservedPrevious).toBe(true);
  expect(result.editedPixels).toBeGreaterThan(80);
  expect(result.edited.map(({ id }) => id)).toEqual(["1"]);
});
