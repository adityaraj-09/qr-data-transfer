import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { initSync as initRaptorQ } from "@raptorqr/raptorq-wasm";
import { RaptorQWasmDecoder } from "@raptorqr/core/fec/raptorq_wasm";
import { encodeQRCodeMatrix } from "@raptorqr/core/qr/qr_encoder_node";
import {
  prepareZXingModule,
  readBarcodes,
  type ReaderOptions,
} from "zxing-wasm/reader";
import { compressForTransfer, decompressTransfer } from "../lib/compression";
import {
  buildOpticalContainer,
  createOpticalTransfer,
  crc32,
  OPTICAL_FRAME_OVERHEAD,
  parseOpticalContainer,
  parseOpticalFrame,
  raptorPacketKey,
} from "../lib/optical-transfer";
import {
  decryptSecrets,
  encryptSecrets,
  isEncryptedVault,
  passphraseStrength,
  VAULT_MIME,
} from "../lib/secrets-crypto";
import {
  bytesToSecrets,
  parseEnv,
  secretsToBytes,
  serializeEnv,
} from "../lib/secrets-format";
import { TRANSFER_PRESETS } from "../lib/transfer-presets";

const require = createRequire(import.meta.url);
let raptorQReady = false;
let zxingReady: Promise<unknown> | undefined;

function prepareRaptorQ() {
  if (raptorQReady) return;
  initRaptorQ({
    module: readFileSync(
      require.resolve(
        "@raptorqr/raptorq-wasm/wasm/raptorqr_raptorq_wasm_bg.wasm",
      ),
    ),
  });
  raptorQReady = true;
}

function prepareZXing() {
  if (!zxingReady) {
    zxingReady = Promise.resolve(
      prepareZXingModule({
        overrides: {
          wasmBinary: readFileSync(
            require.resolve("zxing-wasm/reader/zxing_reader.wasm"),
          ),
        },
        equalityFn: Object.is,
        fireImmediately: true,
      }),
    );
  }
  return zxingReady;
}

function deterministicBytes(length: number) {
  const output = new Uint8Array(length);
  let state = 0x6d2b79f5;
  for (let index = 0; index < length; index += 1) {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    output[index] = (state ^ (state >>> 14)) & 0xff;
  }
  return output;
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

class TestImageData {
  readonly colorSpace = "srgb";

  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

test("file container preserves metadata, compression, and both checksums", async () => {
  const original = new TextEncoder().encode(
    "camera-transfer,raptorq,raw-binary\n".repeat(12_000),
  );
  const compressed = await compressForTransfer(original);
  assert.notEqual(compressed.mode, "none");
  const prepared = buildOpticalContainer(original, compressed.bytes, {
    filename: "research-notes.csv",
    mime: "text/csv",
    compression: compressed.mode,
  });
  const parsed = parseOpticalContainer(prepared.container);
  const recovered = await decompressTransfer(
    parsed.transmitted,
    parsed.meta.compression,
  );

  assert.equal(parsed.meta.filename, "research-notes.csv");
  assert.equal(parsed.meta.mime, "text/csv");
  assert.equal(parsed.meta.fileSize, original.length);
  assert.equal(crc32(recovered), parsed.meta.fileCrc);
  assert.deepEqual(recovered, original);
});

test("raw binary optical frames round-trip and reject corruption", async () => {
  prepareRaptorQ();
  const original = deterministicBytes(12_345);
  const prepared = buildOpticalContainer(original, original, {
    filename: "frame.bin",
    compression: "none",
  });
  const preset = TRANSFER_PRESETS.balanced;
  const transfer = await createOpticalTransfer(prepared, {
    symbolSize: preset.symbolSize,
    repairPercent: preset.repairPercent,
  });
  const frame = parseOpticalFrame(transfer.packets[0]);

  assert.equal(frame.session, transfer.session);
  assert.equal(frame.containerLength, prepared.container.length);
  assert.equal(frame.symbolSize, preset.symbolSize);
  assert.equal(
    transfer.packets[0].length,
    preset.symbolSize + OPTICAL_FRAME_OVERHEAD,
  );

  const damaged = transfer.packets[0].slice();
  damaged[Math.floor(damaged.length * 0.7)] ^= 0x40;
  assert.throws(() => parseOpticalFrame(damaged), /checksum/i);
});

test("RaptorQ reconstructs after unordered camera-frame erasures", async () => {
  prepareRaptorQ();
  const original = deterministicBytes(256 * 1024 + 37);
  const prepared = buildOpticalContainer(original, original, {
    filename: "loss-test.bin",
    mime: "application/octet-stream",
    compression: "none",
  });
  const preset = TRANSFER_PRESETS.turbo;
  const transfer = await createOpticalTransfer(prepared, {
    symbolSize: preset.symbolSize,
    repairPercent: preset.repairPercent,
  });
  const random = seededRandom(0xdecafbad);
  const received = transfer.packets
    .filter(() => random() >= 0.12)
    .sort(() => random() - 0.5);
  const decoder = await RaptorQWasmDecoder.create(
    transfer.containerLength,
    transfer.symbolSize,
  );
  const seen = new Set<string>();
  let decoded: Uint8Array | null = null;

  for (const encoded of received) {
    const frame = parseOpticalFrame(encoded);
    const key = raptorPacketKey(frame);
    if (seen.has(key)) continue;
    seen.add(key);
    decoded = decoder.push(frame.payload);
    if (decoded) break;
  }

  assert.ok(
    decoded,
    `RaptorQ did not recover from ${transfer.packets.length - received.length} erased frames`,
  );
  assert.equal(crc32(decoded), transfer.session);
  const recovered = parseOpticalContainer(decoded);
  assert.deepEqual(recovered.transmitted, original);
});

test("the actual Turbo and 1 Mbps QR profiles survive the ZXing scanner", async () => {
  await prepareZXing();
  for (const preset of [
    TRANSFER_PRESETS.turbo,
    TRANSFER_PRESETS.megabit,
  ]) {
    const packet = deterministicBytes(preset.qrCapacity);
    const matrix = await encodeQRCodeMatrix(
      packet,
      preset.version,
      preset.ecc,
    );
    const quietZone = 4;
    const scale = 5;
    const width = (matrix.length + quietZone * 2) * scale;
    const rgba = new Uint8ClampedArray(width * width * 4);
    const random = seededRandom(12345 + preset.version);

    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const moduleX = Math.floor(x / scale) - quietZone;
        const moduleY = Math.floor(y / scale) - quietZone;
        const dark =
          moduleX >= 0 &&
          moduleY >= 0 &&
          moduleX < matrix.length &&
          moduleY < matrix.length &&
          matrix[moduleY][moduleX];
        const noise = Math.floor(random() * 25);
        const value = dark ? noise : 255 - noise;
        const offset = (y * width + x) * 4;
        rgba[offset] = value;
        rgba[offset + 1] = value;
        rgba[offset + 2] = value;
        rgba[offset + 3] = 255;
      }
    }

    const options: ReaderOptions = {
      formats: ["QRCode"],
      tryHarder: true,
      tryRotate: false,
      tryInvert: false,
      maxNumberOfSymbols: 1,
    };
    const results = await readBarcodes(
      new TestImageData(rgba, width, width) as unknown as ImageData,
      options,
    );
    assert.equal(results.length, 1, `${preset.label} should decode`);
    assert.deepEqual(new Uint8Array(results[0].bytes), packet);
  }
});

test("ZXing recovers two noisy side-by-side Turbo lanes in one exposure", async () => {
  await prepareZXing();
  const preset = TRANSFER_PRESETS.turbo60;
  const packets = [
    deterministicBytes(preset.qrCapacity),
    deterministicBytes(preset.qrCapacity),
  ];
  packets[1][0] ^= 0x5a;
  const matrices = await Promise.all(
    packets.map((packet) =>
      encodeQRCodeMatrix(packet, preset.version, preset.ecc),
    ),
  );
  const quietZone = 4;
  const scale = 5;
  const side = (matrices[0].length + quietZone * 2) * scale;
  const width = side * 2;
  const rgba = new Uint8ClampedArray(width * side * 4);
  const random = seededRandom(0x2d30);

  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const lane = x < side ? 0 : 1;
      const laneX = x - lane * side;
      const moduleX = Math.floor(laneX / scale) - quietZone;
      const moduleY = Math.floor(y / scale) - quietZone;
      const matrix = matrices[lane];
      const dark =
        moduleX >= 0 &&
        moduleY >= 0 &&
        moduleX < matrix.length &&
        moduleY < matrix.length &&
        matrix[moduleY][moduleX];
      const noise = Math.floor(random() * 25);
      const value = dark ? noise : 255 - noise;
      const offset = (y * width + x) * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }

  const results = await readBarcodes(
    new TestImageData(rgba, width, side) as unknown as ImageData,
    {
      formats: ["QRCode"],
      tryHarder: true,
      tryRotate: false,
      tryInvert: false,
      maxNumberOfSymbols: 2,
    },
  );
  const expected = packets
    .map((packet) => Buffer.from(packet).toString("hex"))
    .sort();
  const actual = results
    .filter((result) => result.isValid)
    .map((result) => Buffer.from(result.bytes).toString("hex"))
    .sort();
  assert.deepEqual(actual, expected);

  const replacementPacket = deterministicBytes(preset.qrCapacity);
  replacementPacket[1] ^= 0xa5;
  const replacementMatrix = await encodeQRCodeMatrix(
    replacementPacket,
    preset.version,
    preset.ecc,
  );
  for (let y = Math.floor(side / 2); y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const moduleX = Math.floor(x / scale) - quietZone;
      const moduleY = Math.floor(y / scale) - quietZone;
      const dark =
        moduleX >= 0 &&
        moduleY >= 0 &&
        moduleX < replacementMatrix.length &&
        moduleY < replacementMatrix.length &&
        replacementMatrix[moduleY][moduleX];
      const noise = Math.floor(random() * 25);
      const value = dark ? noise : 255 - noise;
      const offset = (y * width + x) * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
    }
  }
  const mixedResults = await readBarcodes(
    new TestImageData(rgba, width, side) as unknown as ImageData,
    {
      formats: ["QRCode"],
      tryHarder: true,
      tryRotate: false,
      tryInvert: false,
      maxNumberOfSymbols: 2,
    },
  );
  const stableLane = Buffer.from(packets[1]).toString("hex");
  assert.ok(
    mixedResults.some(
      (result) =>
        result.isValid &&
        Buffer.from(result.bytes).toString("hex") === stableLane,
    ),
    "the unchanged lane should survive a rolling-shutter transition in its neighbor",
  );
});

test("env parser and serializer preserve keys, quotes, and comments", () => {
  const text = [
    "# staging",
    "API_KEY=plain",
    'DATABASE_URL="postgres://user:pass@host/db"',
    "export TOKEN='abc=def'",
    "",
    "BAD KEY=nope",
    "EMPTY=",
  ].join("\n");
  const secrets = parseEnv(text);
  assert.deepEqual(secrets, [
    { key: "API_KEY", value: "plain" },
    { key: "DATABASE_URL", value: "postgres://user:pass@host/db" },
    { key: "TOKEN", value: "abc=def" },
    { key: "EMPTY", value: "" },
  ]);
  const roundTrip = parseEnv(serializeEnv(secrets));
  assert.deepEqual(roundTrip, secrets);
});

test("secrets byte codec validates JSON shape", () => {
  const secrets = [
    { key: "OPENAI_API_KEY", value: "sk-test" },
    { key: "DB_PASSWORD", value: "s3cret" },
  ];
  const bytes = secretsToBytes(secrets);
  assert.deepEqual(bytesToSecrets(bytes), secrets);
  assert.throws(
    () => bytesToSecrets(new TextEncoder().encode('{"no":"array"}')),
    /array/i,
  );
  assert.throws(
    () => bytesToSecrets(new TextEncoder().encode('[{"key":1,"value":"x"}]')),
    /invalid secret/i,
  );
});

test("vault crypto round-trips and rejects wrong passphrases", async () => {
  const secrets = [{ key: "SERVICE_TOKEN", value: "rotate-me-now" }];
  const plaintext = secretsToBytes(secrets);
  const encrypted = await encryptSecrets(plaintext, "correct horse battery");
  assert.equal(isEncryptedVault(encrypted), true);
  assert.equal(isEncryptedVault(plaintext), false);

  const unlocked = await decryptSecrets(encrypted, "correct horse battery");
  assert.deepEqual(bytesToSecrets(unlocked), secrets);
  await assert.rejects(
    () => decryptSecrets(encrypted, "wrong passphrase"),
    /Wrong passphrase|corrupted/i,
  );
  assert.equal(passphraseStrength("short").level, "weak");
  assert.ok(passphraseStrength("correct horse battery staple").bits >= 40);
});

test("encrypted vault survives the optical compress + RaptorQ pipeline", async () => {
  prepareRaptorQ();
  const secrets = [
    { key: "API_KEY", value: "sk-live-" + "x".repeat(48) },
    { key: "DATABASE_URL", value: "postgres://vault:pass@db/prod" },
  ];
  const encrypted = await encryptSecrets(
    secretsToBytes(secrets),
    "vault-passphrase-strong-enough",
  );
  const compressed = await compressForTransfer(encrypted);
  const prepared = buildOpticalContainer(encrypted, compressed.bytes, {
    filename: "qrvault.env",
    mime: VAULT_MIME,
    compression: compressed.mode,
  });
  assert.equal(prepared.meta.mime, VAULT_MIME);

  const transfer = await createOpticalTransfer(prepared, {
    symbolSize: TRANSFER_PRESETS.robust.symbolSize,
    repairPercent: TRANSFER_PRESETS.robust.repairPercent,
  });
  const decoder = await RaptorQWasmDecoder.create(
    transfer.containerLength,
    transfer.symbolSize,
  );
  let decoded: Uint8Array | null = null;
  for (const packet of transfer.packets) {
    decoded = decoder.push(parseOpticalFrame(packet).payload);
    if (decoded) break;
  }
  assert.ok(decoded);
  const recovered = parseOpticalContainer(decoded);
  const payload = await decompressTransfer(
    recovered.transmitted,
    recovered.meta.compression,
  );
  assert.equal(crc32(payload), recovered.meta.fileCrc);
  assert.equal(recovered.meta.mime, VAULT_MIME);
  const unlocked = await decryptSecrets(payload, "vault-passphrase-strong-enough");
  assert.deepEqual(bytesToSecrets(unlocked), secrets);
});

test("all profiles fit exactly and expose increasing high-speed channels", () => {
  for (const preset of Object.values(TRANSFER_PRESETS)) {
    assert.equal(
      preset.symbolSize + OPTICAL_FRAME_OVERHEAD,
      preset.qrCapacity,
    );
    assert.ok(preset.usefulBytesPerFrame > 0);
  }
  assert.equal(TRANSFER_PRESETS.turbo.version, 30);
  assert.equal(TRANSFER_PRESETS.turbo.fps, 15);
  assert.equal(TRANSFER_PRESETS.turbo30.fps, 30);
  assert.equal(TRANSFER_PRESETS.turbo30.lanes, 1);
  assert.equal(TRANSFER_PRESETS.turbo60.fps, 60);
  assert.equal(TRANSFER_PRESETS.turbo60.lanes, 2);
  assert.equal(TRANSFER_PRESETS.megabit.version, 40);
  assert.equal(TRANSFER_PRESETS.megabit.fps, 60);
  assert.equal(TRANSFER_PRESETS.megabit.lanes, 2);
  assert.ok(
    TRANSFER_PRESETS.turbo.usefulBytesPerFrame *
      TRANSFER_PRESETS.turbo.fps >
      TRANSFER_PRESETS.robust.usefulBytesPerFrame *
        TRANSFER_PRESETS.robust.fps *
        5,
    "Turbo should offer more than 5x the nominal useful rate of Robust",
  );
  assert.equal(
    TRANSFER_PRESETS.turbo30.usefulBytesPerFrame,
    TRANSFER_PRESETS.turbo.usefulBytesPerFrame,
  );
  assert.equal(
    TRANSFER_PRESETS.turbo60.usefulBytesPerFrame,
    TRANSFER_PRESETS.turbo.usefulBytesPerFrame,
  );
  assert.ok(
    TRANSFER_PRESETS.megabit.usefulBytesPerFrame *
      TRANSFER_PRESETS.megabit.fps *
      8 >
      1_000_000,
    "The 1 Mbps laboratory profile should exceed 1 Mbps before camera loss",
  );
});
