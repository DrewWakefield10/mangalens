import { test, expect } from "@playwright/test";
import path from "node:path";
test("offline import blocks a missing language pair before processing", async ({
  page,
}) => {
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    const health = await response.json();
    await route.fulfill({
      json: {
        ...health,
        offline_pairs: [{ source: "ja", target: "en" }],
        offline_fallback_available: false,
      },
    });
  });
  await page.goto("/translate");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("samples/japanese-page.png"));
  await page
    .getByRole("checkbox", {
      name: "I have permission to upload and translate this content.",
    })
    .check();
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects/upload") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Preview chapter" }).click();
  const project = await (await uploaded).json();
  try {
    await page.getByRole("combobox", { name: "Translation provider" }).selectOption("argos");
    await page
      .getByRole("combobox", { name: "Source language", exact: true })
      .selectOption("en");
    await page
      .getByRole("combobox", { name: "Translate into", exact: true })
      .selectOption("ja");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "is not installed for offline translation" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Translate Chapter" }),
    ).toBeDisabled();
    await page
      .getByRole("combobox", { name: "Source language", exact: true })
      .selectOption("ja");
    await page
      .getByRole("combobox", { name: "Translate into", exact: true })
      .selectOption("en");
    await expect(
      page.getByRole("button", { name: "Translate Chapter" }),
    ).toBeEnabled();
  } finally {
    await page.request.delete("/api/projects/" + project.id, {
      headers: { "X-MangaLens-Client": "web" },
    });
  }
});
test("homepage is responsive and comparison works", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Every Story. Every Language." }),
  ).toBeVisible();
  await page
    .getByRole("slider", { name: "Compare original and translated sample" })
    .fill("25");
  await page.screenshot({
    path: "data/qa/home-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "data/qa/home-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.getByRole("link", { name: "Upload Images" }).click();
  await expect(
    page.getByRole("heading", { name: "Open a new chapter." }),
  ).toBeVisible();
});
test("real Japanese upload, worker, reader, editor and export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/translate");
  await page.getByLabel("Chapter title").fill("Browser verification chapter");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("samples/japanese-page.png"));
  await expect(
    page.getByRole("button", { name: "Preview chapter" }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "I have permission to upload and translate this content.",
    })
    .check();
  await page.getByRole("button", { name: "Preview chapter" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Source language", exact: true })
    .selectOption("ja");
  await page.getByRole("combobox", { name: "Processing profile" }).selectOption("balanced");
  await page.getByRole("combobox", { name: "Translation provider" }).selectOption("argos");
  await page.getByRole("button", { name: "Translate Chapter" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-f0-9]+$/);
  const id = page.url().split("/").pop()!;
  await expect(
    page.getByRole("heading", {
      name: /Your chapter is ready|Pages are ready for review/,
    }),
  ).toBeVisible({ timeout: 90000 });
  await page.getByRole("link", { name: "Open reader" }).click();
  await expect(page.getByAltText("Translated page 1")).toBeVisible();
  await page.getByRole("button", { name: "Original", exact: true }).click();
  await expect(page.getByAltText("Original page 1")).toBeVisible();
  await page.keyboard.press("o");
  await expect(page.getByAltText("Translated page 1")).toBeVisible();
  await page.getByLabel("Comparison mode").selectOption("slider");
  await expect(
    page.getByRole("slider", { name: "Compare page versions" }),
  ).toBeVisible();
  await page.getByLabel("Reading mode").selectOption("double");
  await page.getByLabel("Reading mode").selectOption("scroll");
  await page.screenshot({ path: "data/qa/reader.png", fullPage: true });
  await page.goto("/editor/" + id);
  await expect(
    page.getByRole("textbox", { name: "Translation", exact: true }),
  ).not.toHaveValue("");
  await page
    .getByRole("textbox", { name: "Translation", exact: true })
    .fill("A lovely day.");
  await page.getByRole("button", { name: "Undo edit" }).click();
  await page.getByRole("button", { name: "Redo edit" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Saved.");
  await page.screenshot({ path: "data/qa/editor.png", fullPage: true });
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/projects/" + id);
        return (await res.json()).active;
      },
      { timeout: 30000 },
    )
    .toBeFalsy();
  const res = await page.request.get(
    "/api/projects/" + id + "/export?authorized=true&format=cbz",
  );
  expect(res.ok()).toBeTruthy();
  expect((await res.body()).byteLength).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});

test("manual region drawing, OCR, correction and clean preview", async ({
  page,
}) => {
  await page.goto("/translate");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("samples/japanese-page.png"));
  await page
    .getByRole("checkbox", {
      name: "I have permission to upload and translate this content.",
    })
    .check();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/projects/upload") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Preview chapter" }).click();
  const project = await (await response).json();
  try {
    await page.goto("/editor/" + project.id);
    await page
      .getByRole("button", { name: "Add Text Region", exact: true })
      .click();
    const image = page.locator(".editor-image-wrap > img");
    await expect(image).toBeVisible();
    const b = (await image.boundingBox())!;
    await page.mouse.move(b.x + b.width * 0.05, b.y + b.height * 0.06);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.95, b.y + b.height * 0.46, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(page.getByLabel("Recognized source")).not.toHaveValue("", {
      timeout: 90000,
    });
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/projects/" + project.id)).json())
            .active,
        { timeout: 90000 },
      )
      .toBeFalsy();
    await page.getByLabel("Recognized source").fill("今日はいい天気ですね。");
    await page.getByLabel("I verified the source text").check();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/projects/" + project.id)).json())
            .active,
        { timeout: 30000 },
      )
      .toBeFalsy();
    await page.getByRole("button", { name: "Retranslate saved text" }).click();
    await expect(
      page.getByRole("textbox", { name: "Translation", exact: true }),
    ).toHaveValue(/\S.{4,}/, { timeout: 30000 });
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/projects/" + project.id)).json())
            .active,
        { timeout: 30000 },
      )
      .toBeFalsy();
    await page.getByRole("button", { name: "clean", exact: true }).click();
    await expect(image).toHaveAttribute("src", /\/image\/clean/);
    await page.getByRole("checkbox", { name: "Show region boxes" }).uncheck();
    await expect(page.locator(".region-box")).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Show region boxes" }).check();
    await expect(page.locator(".region-box").first()).toBeVisible();
    await page.screenshot({
      path: "data/qa/pipeline/manual-editor.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "mask", exact: true }).click();
    await expect(page.getByText("White pixels are the removal mask actually applied to Clean.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Proposed mask" }).click();
    await expect(image).toHaveAttribute("src", /\/mask-candidate\?v=/);
    await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.getByText("Pink pixels are the selected region’s proposed mask", { exact: false })).toBeVisible();
    await page.locator(".region-diagnostics summary").click();
    await expect(page.locator(".region-diagnostics")).toContainText("candidate pixels");
    await expect(page.locator(".region-diagnostics")).toContainText("Current stages");
    const retryResponse = page.waitForResponse(response => response.url().endsWith("/retry/mask") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Regenerate mask" }).click();
    expect((await retryResponse).ok()).toBeTruthy();
    await expect.poll(async () =>
      (await (await page.request.get("/api/projects/" + project.id)).json()).active,
      { timeout: 30000 },
    ).toBeFalsy();
    const updated = await (await page.request.get("/api/pages/" + project.pages[0].id + "/regions")).json();
    expect(updated.some((region: { render: { last_retry_stage?: string } }) => region.render.last_retry_stage === "mask")).toBeTruthy();
  } finally {
    await page.request.delete("/api/projects/" + project.id, {
      headers: { "X-MangaLens-Client": "web" },
    });
  }
});
