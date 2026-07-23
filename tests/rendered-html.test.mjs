import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the functional app metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Reels com reação<\/title>/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("ships the local upload and reaction-library experience", async () => {
  const [page, studio, styles, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/reaction-studio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<ReactionStudio \/>/);
  assert.match(studio, /Banco de reações/);
  assert.match(studio, /Criar Reels/);
  assert.match(studio, /Subir novas reações/);
  assert.match(studio, /api\/compositions/);
  assert.match(studio, /api\/videos/);
  assert.match(studio, /api\/reactions/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(packageJson, /dev:engine/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
