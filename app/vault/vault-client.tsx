"use client";

import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { compressForTransfer } from "@/lib/compression";
import {
  buildOpticalContainer,
  createOpticalTransfer,
  formatBytes,
  formatRate,
  OpticalTransfer,
} from "@/lib/optical-transfer";
import {
  encryptSecrets,
  passphraseStrength,
  VAULT_MIME,
} from "@/lib/secrets-crypto";
import {
  formatMaskedPreview,
  parseEnv,
  SecretEntry,
  secretsToBytes,
} from "@/lib/secrets-format";
import {
  TRANSFER_PRESETS,
  TransferPresetKey,
} from "@/lib/transfer-presets";

type InputTab = "editor" | "paste" | "upload";

function evenlyInterleave(source: number[], repair: number[]) {
  if (source.length === 0) return [...repair];
  if (repair.length === 0) return [...source];
  const order: number[] = [];
  let repairIndex = 0;
  let accumulator = 0;
  for (const sourceIndex of source) {
    order.push(sourceIndex);
    accumulator += repair.length;
    while (repairIndex < repair.length && accumulator >= source.length) {
      order.push(repair[repairIndex]);
      repairIndex += 1;
      accumulator -= source.length;
    }
  }
  while (repairIndex < repair.length) {
    order.push(repair[repairIndex]);
    repairIndex += 1;
  }
  return order;
}

function estimateDuration(
  transfer: OpticalTransfer,
  preset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
) {
  const seconds = transfer.sourcePacketCount / (preset.fps * 0.78);
  if (seconds < 60) return `about ${Math.max(1, Math.ceil(seconds))} sec`;
  const minutes = seconds / 60;
  return `about ${minutes >= 10 ? Math.ceil(minutes) : minutes.toFixed(1)} min`;
}

function emptySecret(): SecretEntry {
  return { key: "", value: "" };
}

export function VaultClient() {
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const qrStageRef = useRef<HTMLDivElement>(null);
  const transferRef = useRef<OpticalTransfer | undefined>(undefined);
  const orderRef = useRef<number[]>([]);
  const playedFramesRef = useRef(0);
  const broadcastFrameTimesRef = useRef<number[]>([]);
  const encodeJobRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<InputTab>("editor");
  const [secrets, setSecrets] = useState<SecretEntry[]>([emptySecret()]);
  const [visibleValues, setVisibleValues] = useState<Set<number>>(new Set());
  const [pasteText, setPasteText] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [noEncryption, setNoEncryption] = useState(false);
  const [presetKey, setPresetKey] = useState<TransferPresetKey>("robust");
  const [transfer, setTransfer] = useState<OpticalTransfer>();
  const [playing, setPlaying] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [playedFrames, setPlayedFrames] = useState(0);
  const [actualFps, setActualFps] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const preset = TRANSFER_PRESETS[presetKey];
  const strength = passphraseStrength(passphrase);

  const activeSecrets = useMemo(
    () =>
      secrets.filter(
        (entry) => entry.key.trim().length > 0 || entry.value.length > 0,
      ),
    [secrets],
  );

  const validSecrets = useMemo(
    () =>
      activeSecrets.filter(
        (entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key.trim()),
      ),
    [activeSecrets],
  );

  const passphraseReady =
    noEncryption ||
    (passphrase.length > 0 &&
      passphrase === passphraseConfirm &&
      strength.level !== "weak");

  const canEncrypt =
    validSecrets.length > 0 &&
    passphraseReady &&
    !processing &&
    (noEncryption || passphrase === passphraseConfirm);

  const installTransfer = useCallback((next: OpticalTransfer) => {
    const order = evenlyInterleave(
      next.sourcePacketIndices,
      next.repairPacketIndices,
    );
    transferRef.current = next;
    orderRef.current = order;
    playedFramesRef.current = 0;
    setPlayedFrames(0);
    setTransfer(next);
  }, []);

  const updateSecret = (index: number, patch: Partial<SecretEntry>) => {
    setSecrets((current) =>
      current.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    );
    setTransfer(undefined);
    transferRef.current = undefined;
    setPlaying(false);
  };

  const addSecret = () => {
    setSecrets((current) => [...current, emptySecret()]);
  };

  const removeSecret = (index: number) => {
    setSecrets((current) => {
      const next = current.filter((_, entryIndex) => entryIndex !== index);
      return next.length > 0 ? next : [emptySecret()];
    });
    setVisibleValues((current) => {
      const next = new Set<number>();
      for (const value of current) {
        if (value < index) next.add(value);
        else if (value > index) next.add(value - 1);
      }
      return next;
    });
    setTransfer(undefined);
    transferRef.current = undefined;
    setPlaying(false);
  };

  const applyParsedSecrets = (parsed: SecretEntry[]) => {
    setSecrets(parsed.length > 0 ? parsed : [emptySecret()]);
    setVisibleValues(new Set());
    setTransfer(undefined);
    transferRef.current = undefined;
    setPlaying(false);
  };

  const onPasteChange = (value: string) => {
    setPasteText(value);
    applyParsedSecrets(parseEnv(value));
  };

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setPasteText(text);
      applyParsedSecrets(parseEnv(text));
      setTab("paste");
    } catch {
      setError("That .env file could not be read.");
    }
  };

  const encryptAndStream = useCallback(async () => {
    if (!canEncrypt) return;
    const job = encodeJobRef.current + 1;
    encodeJobRef.current = job;
    setProcessing(true);
    setError("");
    setPlaying(false);
    setActualFps(0);

    try {
      const normalized = validSecrets.map((entry) => ({
        key: entry.key.trim(),
        value: entry.value,
      }));
      const plaintext = secretsToBytes(normalized);
      const payload = noEncryption
        ? plaintext
        : await encryptSecrets(plaintext, passphrase);
      const compressed = await compressForTransfer(payload);
      const prepared = buildOpticalContainer(payload, compressed.bytes, {
        filename: "qrvault.env",
        mime: VAULT_MIME,
        compression: compressed.mode,
      });
      const nextPreset = TRANSFER_PRESETS[presetKey];
      const next = await createOpticalTransfer(prepared, {
        symbolSize: nextPreset.symbolSize,
        repairPercent: nextPreset.repairPercent,
      });
      if (encodeJobRef.current === job) installTransfer(next);
    } catch (cause) {
      if (encodeJobRef.current === job) {
        setTransfer(undefined);
        transferRef.current = undefined;
        setError(
          cause instanceof Error
            ? cause.message
            : "The vault stream could not be prepared.",
        );
      }
    } finally {
      if (encodeJobRef.current === job) setProcessing(false);
    }
  }, [
    canEncrypt,
    installTransfer,
    noEncryption,
    passphrase,
    presetKey,
    validSecrets,
  ]);

  const renderPacket = useCallback(
    async (
      target: OpticalTransfer,
      packetIndex: number,
      activePreset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
      laneIndex = 0,
    ) => {
      const canvas = canvasRefs.current[laneIndex];
      if (!canvas) return;
      const { renderRawQr } = await import("@/lib/qr-renderer");
      const image = await renderRawQr(
        target.packets[packetIndex],
        activePreset.version,
        activePreset.ecc,
        activePreset.renderScale,
      );
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("The QR drawing surface is unavailable.");
      context.putImageData(image, 0, 0);
    },
    [],
  );

  useEffect(() => {
    if (!transfer || orderRef.current.length === 0) return;
    void Promise.all(
      Array.from({ length: preset.lanes }, (_, laneIndex) =>
        renderPacket(
          transfer,
          orderRef.current[laneIndex % orderRef.current.length],
          preset,
          laneIndex,
        ),
      ),
    ).catch(() => setError("The QR preview could not be rendered."));
  }, [preset, renderPacket, transfer]);

  useEffect(() => {
    if (!playing || !transfer) return;
    let cancelled = false;
    let animationFrame = 0;
    const interval = 1000 / preset.fps;
    let nextFrameAt = performance.now();
    broadcastFrameTimesRef.current = [];

    const tick = async (now: number) => {
      if (now + 0.5 < nextFrameAt) {
        animationFrame = window.requestAnimationFrame(tick);
        return;
      }
      const activeTransfer = transferRef.current;
      const order = orderRef.current;
      if (!activeTransfer || order.length === 0 || cancelled) return;
      const packetIndex = order[playedFramesRef.current % order.length];
      const laneIndex = playedFramesRef.current % preset.lanes;
      try {
        await renderPacket(activeTransfer, packetIndex, preset, laneIndex);
      } catch {
        setError("QR rendering paused after an unexpected error.");
        setPlaying(false);
        return;
      }
      if (cancelled) return;
      playedFramesRef.current += 1;
      const completedAt = performance.now();
      const frameTimes = broadcastFrameTimesRef.current;
      frameTimes.push(completedAt);
      while (
        frameTimes.length > 2 &&
        completedAt - frameTimes[0] > 2500
      ) {
        frameTimes.shift();
      }

      const uiInterval = Math.max(1, Math.round(preset.fps / 10));
      if (playedFramesRef.current % uiInterval === 0) {
        setPlayedFrames(playedFramesRef.current);
        if (frameTimes.length > 1) {
          setActualFps(
            ((frameTimes.length - 1) * 1000) /
              (frameTimes[frameTimes.length - 1] - frameTimes[0]),
          );
        }
      }

      nextFrameAt += interval;
      if (nextFrameAt < completedAt - interval) {
        nextFrameAt = completedAt + interval;
      }
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
    };
  }, [playing, preset, renderPacket, transfer]);

  const scanUrl = useMemo(() => {
    if (typeof window === "undefined") return "/scan";
    return `${window.location.origin}/scan`;
  }, []);

  const copyScanLink = async () => {
    try {
      await navigator.clipboard?.writeText(scanUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Copy failed. Open this site on the phone and choose Scan.");
    }
  };

  const toggleFullscreen = async () => {
    if (!qrStageRef.current) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        setActualFps(0);
        setPlaying(true);
        await qrStageRef.current.requestFullscreen();
      }
    } catch {
      setPlaying(false);
      setError(
        "Fullscreen is not available in this browser. Maximize the window instead.",
      );
    }
  };

  const orderLength = transfer?.packets.length ?? 0;
  const cycleFrame =
    orderLength > 0
      ? playedFrames === 0
        ? 0
        : ((playedFrames - 1) % orderLength) + 1
      : 0;
  const cycleNumber =
    orderLength > 0 && playedFrames > 0
      ? Math.floor((playedFrames - 1) / orderLength) + 1
      : 1;
  const cycleProgress = orderLength ? cycleFrame / orderLength : 0;
  const nominalRate = preset.usefulBytesPerFrame * preset.fps;
  const maskedPreview = formatMaskedPreview(validSecrets);

  return (
    <main>
      <section className="sender-hero">
        <div>
          <p className="eyebrow">QRVAULT</p>
          <h1>
            Move secrets
            <br />
            through the camera.
          </h1>
        </div>
        <div className="hero-copy">
          <p>
            Encrypt API keys and .env values with AES-GCM, then stream them with
            the same air-gapped RaptorQ pipeline. The phone reveals secrets only
            after the passphrase unlocks.
          </p>
          <div className="trust-row">
            <span>AES-GCM-256</span>
            <span>PBKDF2 200k</span>
            <span>Local only</span>
          </div>
        </div>
      </section>

      <section className="sender-grid" aria-label="Create a vault transfer">
        <div className="control-panel">
          <div className="step-heading">
            <span>01</span>
            <div>
              <h2>Collect secrets</h2>
              <p>Edit keys, paste a .env, or upload a file.</p>
            </div>
          </div>

          <div className="vault-tabs" role="tablist" aria-label="Secrets input">
            {(
              [
                ["editor", "Editor"],
                ["paste", "Paste .env"],
                ["upload", "Upload"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`vault-tab-btn ${tab === id ? "selected" : ""}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "editor" ? (
            <div className="vault-editor">
              {secrets.map((entry, index) => (
                <div className="secret-row" key={index}>
                  <input
                    className="secret-key-input"
                    value={entry.key}
                    placeholder="KEY"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(event) =>
                      updateSecret(index, { key: event.target.value })
                    }
                    aria-label={`Secret key ${index + 1}`}
                  />
                  <input
                    className="secret-value-input"
                    type={visibleValues.has(index) ? "text" : "password"}
                    value={entry.value}
                    placeholder="value"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(event) =>
                      updateSecret(index, { value: event.target.value })
                    }
                    aria-label={`Secret value ${index + 1}`}
                  />
                  <button
                    type="button"
                    className="secret-reveal-btn"
                    onClick={() =>
                      setVisibleValues((current) => {
                        const next = new Set(current);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      })
                    }
                    aria-label={
                      visibleValues.has(index) ? "Hide value" : "Show value"
                    }
                  >
                    {visibleValues.has(index) ? "Hide" : "Show"}
                  </button>
                  <button
                    type="button"
                    className="secret-reveal-btn"
                    onClick={() => removeSecret(index)}
                    aria-label={`Delete secret ${index + 1}`}
                  >
                    Delete
                  </button>
                </div>
              ))}
              <button className="link-action" type="button" onClick={addSecret}>
                + Add secret
              </button>
            </div>
          ) : null}

          {tab === "paste" ? (
            <textarea
              className="vault-paste"
              value={pasteText}
              onChange={(event) => onPasteChange(event.target.value)}
              placeholder={"API_KEY=...\nDATABASE_URL=...\n# comments ok"}
              spellCheck={false}
              aria-label="Paste .env contents"
            />
          ) : null}

          {tab === "upload" ? (
            <div className="drop-zone">
              <input
                ref={fileInputRef}
                type="file"
                accept=".env,text/plain"
                onChange={onUpload}
                aria-label="Upload a .env file"
              />
              <button
                className="file-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                <span aria-hidden="true">＋</span>
                Choose .env file
              </button>
              <p>Keys stay in this browser until you stream them</p>
            </div>
          ) : null}

          <p className="vault-masked-preview" aria-live="polite">
            {maskedPreview}
          </p>

          <div className="step-heading compact">
            <span>02</span>
            <div>
              <h2>Protect with a passphrase</h2>
              <p>AES-GCM-256 · PBKDF2 200k iterations · SHA-256</p>
            </div>
          </div>

          <label className="vault-passphrase-label">
            Passphrase
            <div className="vault-passphrase-row">
              <input
                type={showPassphrase ? "text" : "password"}
                value={passphrase}
                disabled={noEncryption}
                onChange={(event) => {
                  setPassphrase(event.target.value);
                  setTransfer(undefined);
                  transferRef.current = undefined;
                  setPlaying(false);
                }}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="secret-reveal-btn"
                onClick={() => setShowPassphrase((current) => !current)}
              >
                {showPassphrase ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          <label className="vault-passphrase-label">
            Confirm passphrase
            <input
              type={showPassphrase ? "text" : "password"}
              value={passphraseConfirm}
              disabled={noEncryption}
              onChange={(event) => {
                setPassphraseConfirm(event.target.value);
                setTransfer(undefined);
                transferRef.current = undefined;
                setPlaying(false);
              }}
              autoComplete="new-password"
            />
          </label>

          {!noEncryption && passphrase ? (
            <div
              className="passphrase-strength"
              data-level={strength.level}
              aria-live="polite"
            >
              <strong>{strength.label}</strong>
              <span>~{strength.bits} bits estimated</span>
            </div>
          ) : null}

          {!noEncryption &&
          passphrase &&
          passphraseConfirm &&
          passphrase !== passphraseConfirm ? (
            <p className="error-message" role="alert">
              Passphrases do not match.
            </p>
          ) : null}

          <label className="vault-no-encrypt">
            <input
              type="checkbox"
              checked={noEncryption}
              onChange={(event) => {
                setNoEncryption(event.target.checked);
                setTransfer(undefined);
                transferRef.current = undefined;
                setPlaying(false);
              }}
            />
            No encryption (not recommended)
          </label>
          {noEncryption ? (
            <p className="no-encrypt-warning" role="alert">
              Secrets will travel as plaintext inside the optical stream. Anyone
              who scans the QR codes can read them.
            </p>
          ) : null}

          <div className="step-heading compact">
            <span>03</span>
            <div>
              <h2>Tune the channel</h2>
              <p>Same presets as file transfer. Robust is safest for secrets.</p>
            </div>
          </div>

          <div className="preset-list" role="radiogroup" aria-label="Signal preset">
            {(Object.keys(TRANSFER_PRESETS) as TransferPresetKey[]).map((key) => {
              const option = TRANSFER_PRESETS[key];
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={presetKey === key}
                  className={presetKey === key ? "selected" : ""}
                  key={key}
                  onClick={() => {
                    setPresetKey(key);
                    setPlaying(false);
                    setActualFps(0);
                    setTransfer(undefined);
                    transferRef.current = undefined;
                  }}
                >
                  <span className="radio-dot" aria-hidden="true" />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                  <b>
                    {option.lanes === 1
                      ? `${option.fps} fps`
                      : `${option.fps} symbols/s · ${option.fps / option.lanes} fps/lane`}
                    {" · "}
                    {formatRate(option.usefulBytesPerFrame * option.fps)}
                  </b>
                </button>
              );
            })}
          </div>

          <button
            className="primary-action"
            type="button"
            disabled={!canEncrypt}
            onClick={() => void encryptAndStream()}
          >
            <span aria-hidden="true">{processing ? "…" : "⊘"}</span>
            {processing
              ? noEncryption
                ? "Building stream…"
                : "Encrypting…"
              : noEncryption
                ? "Build stream"
                : "Encrypt & Stream"}
          </button>

          {error ? (
            <p className="error-message" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="qr-panel">
          <div className="step-heading inverse">
            <span>04</span>
            <div>
              <h2>Play the QR stream</h2>
              <p>
                {preset.lanes === 2
                  ? "Keep both complete codes inside the landscape phone guide."
                  : "Fill the phone guide with this one complete code."}
              </p>
            </div>
          </div>

          <div
            ref={qrStageRef}
            className={`qr-stage ${transfer ? "ready" : ""} ${playing ? "playing" : ""} lanes-${preset.lanes}`}
          >
            {transfer ? (
              <div className={`qr-canvas-grid lanes-${preset.lanes}`}>
                {Array.from({ length: preset.lanes }, (_, laneIndex) => (
                  <canvas
                    key={laneIndex}
                    ref={(canvas) => {
                      canvasRefs.current[laneIndex] = canvas;
                    }}
                    aria-label={
                      preset.lanes === 1
                        ? "Animated vault transfer"
                        : `Animated vault transfer lane ${laneIndex + 1}`
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="qr-placeholder" aria-hidden="true">
                <div className="finder top-left" />
                <div className="finder top-right" />
                <div className="finder bottom-left" />
                <span>
                  {processing ? "Preparing vault…" : "Vault stream appears here"}
                </span>
              </div>
            )}
            <button
              className="fullscreen-button"
              type="button"
              onClick={toggleFullscreen}
              disabled={!transfer}
              aria-label="Show QR code fullscreen"
            >
              ⛶
            </button>
          </div>

          <div className="stream-status" aria-live="polite">
            <div>
              <span
                className={`pulse-dot ${playing ? "live" : ""}`}
                aria-hidden="true"
              />
              <strong>
                {playing
                  ? "Broadcasting vault"
                  : transfer
                    ? "Ready to broadcast"
                    : processing
                      ? "Encoding"
                      : "Waiting for secrets"}
              </strong>
            </div>
            <span>
              {transfer
                ? `${estimateDuration(transfer, preset)} · ${formatRate(nominalRate)} nominal${
                    playing && actualFps > 0
                      ? ` · ${actualFps.toFixed(1)} fps rendered`
                      : ""
                  } · ${formatBytes(transfer.meta.fileSize)}`
                : "Open /scan on the receiving phone"}
            </span>
          </div>

          {transfer ? (
            <div className="broadcast-progress">
              <div>
                <strong>RaptorQ cycle {cycleNumber}</strong>
                <span>
                  frame {cycleFrame.toLocaleString()} /{" "}
                  {orderLength.toLocaleString()} ·{" "}
                  {transfer.sourcePacketCount.toLocaleString()} source +{" "}
                  {transfer.repairPacketIndices.length.toLocaleString()} repair
                </span>
              </div>
              <div
                className="broadcast-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(cycleProgress * 100)}
              >
                <span style={{ width: `${cycleProgress * 100}%` }} />
              </div>
            </div>
          ) : null}

          <button
            className="primary-action"
            type="button"
            disabled={!transfer || processing}
            onClick={() => {
              if (!playing) setActualFps(0);
              setPlaying((current) => !current);
            }}
          >
            <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
            {playing ? "Pause stream" : "Start QR stream"}
          </button>

          <button className="link-action" type="button" onClick={copyScanLink}>
            <span aria-hidden="true">⌁</span>
            {copied ? "Scanner link copied" : "Copy mobile scanner link"}
          </button>
        </div>
      </section>
    </main>
  );
}
