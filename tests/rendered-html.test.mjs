import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the sender product surface", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Send a file · QRFerry<\/title>/i);
  assert.match(html, /Move a file/);
  assert.match(html, /Choose a file/);
  assert.match(html, /Start QR stream/);
  assert.match(html, /Brotli-11 \+ gzip-9/);
  assert.match(html, /RaptorQ FEC/);
  assert.match(html, /dual modes alternate two stable lanes/i);
  assert.match(html, /Turbo 30/);
  assert.match(html, /1 Mbps/);
  assert.doesNotMatch(html, /codex-preview|loading skeleton/i);
});

test("server-renders the mobile scanner surface", async () => {
  const response = await render("/scan");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Scan a transfer · QRFerry<\/title>/i);
  assert.match(html, /Point\. Hold\. Receive\./);
  assert.match(html, /Start camera/);
  assert.match(html, /File recovery progress/);
  assert.match(html, /Effective file rate/);
  assert.match(html, /Dual lane/);
  assert.match(html, /decode p50 \/ p95/i);
  assert.match(html, /one raw-binary QR per exposure|Dual-lane scanning/);
});

test("server-renders the vault secrets surface", async () => {
  const response = await render("/vault");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Vault · QRFerry<\/title>/i);
  assert.match(html, /Move secrets/);
  assert.match(html, /Collect secrets/);
  assert.match(html, /Encrypt &amp; Stream|Encrypt & Stream/);
  assert.match(html, /AES-GCM-256/);
  assert.match(html, /PBKDF2 200k/);
  assert.match(html, /No encryption/);
});
