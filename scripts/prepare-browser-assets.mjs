import { cp, mkdir } from "node:fs/promises";
const target = new URL("../public/pdfjs/", import.meta.url);
const source = new URL("../node_modules/pdfjs-dist/", import.meta.url);
await mkdir(target, { recursive: true });
await cp(
  new URL("build/pdf.worker.min.mjs", source),
  new URL("pdf.worker.min.mjs", target),
);
for (const name of ["cmaps", "standard_fonts", "wasm", "iccs"])
  await cp(new URL(name, source), new URL(name, target), { recursive: true });
