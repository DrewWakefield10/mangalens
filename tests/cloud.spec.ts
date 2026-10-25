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
    page.getByRole("dialog").getByText("1 pages", { exact: false }),
  ).toBeVisible();
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
  await page
    .getByRole("textbox", { name: "Translation", exact: true })
    .fill("The next adventure");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Saved. This page is being rendered again.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/projects/" + id);
  await expect(
    page.getByText("Pages are ready for review", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
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
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  const imported = await request.post(
    "/api/projects/" + project.id + "/pages",
    {
      headers,
      data: {
        pages: [{ name: "one.png", width: 1, height: 1, bytes: png.length }],
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
  expect(second.page.regions[0].source_text).toBe("Hello!");
  expect(
    (
      await request.post("/api/pages/" + asset.id + "/failed", {
        headers,
        data: { token: second.token, message: "Interrupted fixture request" },
      })
    ).ok(),
  ).toBeTruthy();
  const region = second.page.regions[0];
  expect(
    (
      await request.put("/api/regions/" + region.id, {
        headers,
        data: { page_version: 1 },
      })
    ).status(),
  ).toBe(409);
  expect(
    (await request.delete("/api/projects/" + project.id, { headers })).ok(),
  ).toBeTruthy();
});
