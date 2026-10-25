import { api, type Project } from "./api";
import { CLOUD_LIMITS as L } from "./cloud-types";
export async function blobOf(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality?: number,
) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b
          ? resolve(b)
          : reject(new Error("The browser could not encode this page.")),
      type,
      quality,
    ),
  );
}
export function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
export async function uploadImage(
  url: string,
  image: Blob,
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "image/png", "x-upsert": "true" },
    body: image,
    signal,
  });
  if (!response.ok)
    throw new Error(
      "Image upload failed. Your existing chapters are preserved; retry the import.",
    );
}
async function archive(file: File): Promise<File[]> {
  const { Unzip, UnzipInflate } = await import("fflate");
  const input = new Uint8Array(await file.arrayBuffer());
  const output: File[] = [];
  let total = 0;
  let failure: Error | undefined;
  const unzip = new Unzip((entry) => {
    if (
      !/\.(png|jpe?g|webp)$/i.test(entry.name) ||
      /(^|\/)__MACOSX\//.test(entry.name)
    )
      return;
    if (
      entry.name.split(/[\\/]/).includes("..") ||
      entry.name.startsWith("/")
    ) {
      failure = new Error("The archive contains an unsafe filename.");
      return;
    }
    if (
      output.length >= L.maxPages ||
      (entry.originalSize || 0) > 32 * 1024 * 1024
    ) {
      failure = new Error("The archive exceeds the page or image size limit.");
      return;
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    // Reserve a slot before decompressing, so nested callbacks cannot evade the page limit.
    const index = output.length;
    output.push(new File([], "pending.png"));
    entry.ondata = (error, data, final) => {
      if (error) {
        failure = error;
        return;
      }
      total += data.length;
      length += data.length;
      if (total > L.maxExpandedBytes || length > 32 * 1024 * 1024) {
        failure = new Error(
          "The archive expands beyond the supported size. Use a smaller chapter.",
        );
        entry.terminate();
        return;
      }
      chunks.push(data.slice());
      if (final)
        output[index] = new File(
          chunks as BlobPart[],
          entry.name.split(/[\\/]/).pop()!,
        );
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < input.length; offset += 4096) {
    unzip.push(
      input.subarray(offset, offset + 4096),
      offset + 4096 >= input.length,
    );
    if (failure) throw failure;
    if (offset % 131072 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  if (!output.length)
    throw new Error("No PNG, JPG, or WebP pages were found in this archive.");
  return output.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}
async function pdf(file: File): Promise<File[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useSystemFonts: true,
    stopAtErrors: true,
    maxImageSize: L.maxPixels,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
  });
  const doc = await task.promise;
  try {
    if (doc.numPages > L.maxPages)
      throw new Error(
        "This PDF exceeds the 20-page limit. Import a smaller chapter.",
      );
    const result: File[] = [];
    for (let index = 1; index <= doc.numPages; index++) {
      const page = await doc.getPage(index);
      const unit = page.getViewport({ scale: 1 });
      const scale = Math.min(
        2,
        Math.sqrt(L.maxPixels / (unit.width * unit.height)),
      );
      const viewport = page.getViewport({ scale });
      const canvas = canvasOf(
        Math.floor(viewport.width),
        Math.floor(viewport.height),
      );
      await page.render({ canvas, viewport }).promise;
      result.push(
        new File(
          [await blobOf(canvas)],
          file.name.replace(/\.pdf$/i, "") +
            "-" +
            String(index).padStart(3, "0") +
            ".png",
          { type: "image/png" },
        ),
      );
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
    return result;
  } finally {
    await task.destroy();
  }
}
export async function normalized(file: File) {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    if (
      bitmap.width * bitmap.height > L.maxPixels ||
      bitmap.width > 12000 ||
      bitmap.height > 12000
    )
      throw new Error(
        file.name +
          ": exceeds the 12-megapixel page limit. Use a smaller image.",
      );
    const canvas = canvasOf(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    const original = await blobOf(canvas);
    canvas.width = canvas.height = 0;
    if (original.size > L.maxFileBytes)
      throw new Error(
        file.name + ": exceeds 8 MB after lossless PNG conversion.",
      );
    const width = Math.min(256, bitmap.width);
    const height = Math.max(
      1,
      Math.round((bitmap.height * width) / bitmap.width),
    );
    const thumb = canvasOf(width, height);
    thumb.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
    const thumbnail = await blobOf(thumb);
    thumb.width = thumb.height = 0;
    return {
      original,
      thumbnail,
      width: bitmap.width,
      height: bitmap.height,
      name: file.name,
    };
  } finally {
    bitmap.close();
  }
}
export async function importCloud(
  files: File[],
  title: string,
  authorized: boolean,
  onProgress: (label: string) => void,
) {
  if (!authorized)
    throw new Error("Confirm you have permission to translate this content.");
  if (files.reduce((n, f) => n + f.size, 0) > L.maxImportBytes)
    throw new Error("Import up to 64 MB at a time.");
  let expanded: File[] = [];
  let expandedBytes = 0;
  for (const file of files) {
    onProgress("Opening " + file.name + "…");
    const list = /\.(zip|cbz)$/i.test(file.name)
      ? await archive(file)
      : /\.pdf$/i.test(file.name)
        ? await pdf(file)
        : [file];
    expanded.push(...list);
    expandedBytes += list.reduce((n, f) => n + f.size, 0);
    if (expanded.length > L.maxPages || expandedBytes > L.maxExpandedBytes)
      throw new Error("Import up to 20 pages and 128 MB of expanded files.");
  }
  if (!expanded.length) throw new Error("Choose at least one page.");
  const pages: Awaited<ReturnType<typeof normalized>>[] = [];
  for (let index = 0; index < expanded.length; index++) {
    onProgress(
      "Preparing page " + (index + 1) + " of " + expanded.length + "…",
    );
    try {
      pages.push(await normalized(expanded[index]));
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : "This file could not be decoded as an image.",
      );
    }
  }
  const project = await api<Project>("/projects", {
    method: "POST",
    body: JSON.stringify({
      title: title || files[0].name.replace(/\.[^.]+$/, ""),
      authorized,
    }),
  });
  try {
    const uploads = await api<
      { id: string; original: string; thumbnail: string }[]
    >("/projects/" + project.id + "/pages", {
      method: "POST",
      body: JSON.stringify({
        pages: pages.map((p) => ({
          name: p.name,
          width: p.width,
          height: p.height,
          bytes: p.original.size,
        })),
      }),
    });
    for (let index = 0; index < pages.length; index++) {
      onProgress("Uploading page " + (index + 1) + " of " + pages.length + "…");
      await uploadImage(uploads[index].original, pages[index].original);
      await uploadImage(uploads[index].thumbnail, pages[index].thumbnail);
      await api("/pages/" + uploads[index].id + "/uploaded", {
        method: "POST",
      });
    }
    return await api<Project>("/projects/" + project.id);
  } catch (error) {
    // This chapter was just created by this import; do not leave a partial library entry.
    await api("/projects/" + project.id, { method: "DELETE" }).catch(() => {});
    throw error;
  }
}
export async function exportCloud(
  project: Project,
  format: string,
  onProgress: (label: string) => void,
) {
  if (!["zip", "cbz", "pdf"].includes(format))
    throw new Error("Unsupported export format.");
  const images: {
    name: string;
    bytes: Uint8Array;
    width: number;
    height: number;
  }[] = [];
  let total = 0;
  for (let index = 0; index < project.pages.length; index++) {
    const p = project.pages[index];
    onProgress(
      "Downloading page " + (index + 1) + " of " + project.pages.length + "…",
    );
    const response = await fetch(p.translated, { credentials: "same-origin" });
    if (!response.ok)
      throw new Error(
        "A translated page could not be downloaded. Retry the export.",
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    total += bytes.length;
    if (total > L.maxExpandedBytes)
      throw new Error(
        "This export exceeds the browser memory limit. Export a smaller chapter.",
      );
    images.push({
      name: String(index + 1).padStart(3, "0") + ".png",
      bytes,
      width: p.width,
      height: p.height,
    });
  }
  let blob: Blob;
  if (format === "pdf") {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    for (const image of images) {
      const embedded = await doc.embedPng(image.bytes);
      const page = doc.addPage([image.width, image.height]);
      page.drawImage(embedded, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      });
    }
    blob = new Blob([(await doc.save()) as BlobPart], {
      type: "application/pdf",
    });
  } else {
    const { zip } = await import("fflate");
    const bytes = await new Promise<Uint8Array>((resolve, reject) =>
      zip(
        Object.fromEntries(images.map((i) => [i.name, i.bytes])),
        { level: 0 },
        (error, data) => (error ? reject(error) : resolve(data)),
      ),
    );
    blob = new Blob([bytes as BlobPart], {
      type:
        format === "cbz" ? "application/vnd.comicbook+zip" : "application/zip",
    });
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download =
    (project.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100) ||
      "mangalens") +
    "." +
    format;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
