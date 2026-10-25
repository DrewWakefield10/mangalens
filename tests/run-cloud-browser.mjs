import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const temp = resolve("../browser-temp");
mkdirSync(temp, { recursive: true });
const env = {
  ...process.env,
  VERCEL: "1",
  TEMP: temp,
  TMP: temp,
  MANGALENS_CLOUD: "1",
  SUPABASE_URL: "http://127.0.0.1:4401",
  MANGALENS_GATEWAY_SECRET: "fixture-secret",
  PLAYWRIGHT_BROWSERS_PATH: resolve("../playwright-browsers"),
  DEEPL_API_KEY: "fixture-only",
  OCR_SPACE_API_KEY: "fixture-only",
  CLOUD_FIXTURE_PORT: "4401",
  PLAYWRIGHT_BASE_URL: "http://localhost:3101",
  CLOUD_BROWSER_TEST: "1",
};
const processes = [];
function run(args) {
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });
  processes.push(child);
  return child;
}
async function wait(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Test server did not start: " + url);
}
try {
  run(["tests/fixtures/cloud-gateway.mjs"]);
  run([
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3101",
  ]);
  await wait("http://127.0.0.1:4401/fixture/state");
  await wait("http://localhost:3101/api/health");
  const tests = run([
    "node_modules/@playwright/test/cli.js",
    "test",
    "tests/cloud.spec.ts",
    ...process.argv.slice(2),
  ]);
  process.exitCode = await new Promise((resolve) =>
    tests.on("exit", (code) => resolve(code ?? 1)),
  );
} finally {
  for (const child of processes.reverse())
    if (child.exitCode === null) child.kill("SIGTERM");
}
