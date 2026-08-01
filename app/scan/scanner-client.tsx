"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decompressTransfer } from "@/lib/compression";
import {
  crc32,
  formatBytes,
  formatRate,
  OpticalFileMeta,
  parseOpticalContainer,
  parseOpticalFrame,
  raptorPacketKey,
} from "@/lib/optical-transfer";
import {
  decryptSecrets,
  isEncryptedVault,
  VAULT_MIME,
} from "@/lib/secrets-crypto";
import {
  bytesToSecrets,
  SecretEntry,
  serializeEnv,
} from "@/lib/secrets-format";

type ScanState =
  | "idle"
  | "starting"
  | "scanning"
  | "receiving"
  | "complete"
  | "error";
type ScanMode = "single" | "dual";
type RateSample = { at: number; bytes: number };
type RaptorDecoder = { push(payload: Uint8Array): Uint8Array | null };
type ReceiverSession = {
  session: number;
  containerLength: number;
  originalSize: number;
  compressed: boolean;
  symbolSize: number;
  sourcePacketCount: number;
  decoder: RaptorDecoder;
  seen: Set<string>;
};
type IncomingMeta = Omit<ReceiverSession, "decoder" | "seen">;
type VideoFrameMetadataLike = {
  presentedFrames?: number;
};
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadataLike) => void,
  ) => number;
};
type DeliverySample = { at: number; frames: number };
type ScanPerformanceSample = {
  at: number;
  decodeMs: number;
};
type CameraSettings = {
  width: number;
  height: number;
  frameRate: number;
};
type ScanMetrics = {
  deliveredFps: number;
  scannerFps: number;
  decodeP50: number;
  decodeP95: number;
};

function updateRollingRate(samples: RateSample[], bytes: number) {
  const now = performance.now();
  samples.push({ at: now, bytes });
  while (samples.length > 1 && now - samples[0].at > 4000) samples.shift();
  const elapsed = Math.max(750, now - samples[0].at);
  const total = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  return (total * 1000) / elapsed;
}

function formatEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "calculating";
  if (seconds < 60) return `${Math.ceil(seconds)} sec`;
  const minutes = seconds / 60;
  return `${minutes >= 10 ? Math.ceil(minutes) : minutes.toFixed(1)} min`;
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function ScannerClient() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scanModeRef = useRef<ScanMode>("single");
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const receiverRef = useRef<ReceiverSession | undefined>(undefined);
  const scanningRef = useRef(false);
  const completingRef = useRef(false);
  const downloadUrlRef = useRef("");
  const scanStartedAtRef = useRef(0);
  const lastQrAtRef = useRef(0);
  const qrReadsRef = useRef(0);
  const acceptedFramesRef = useRef(0);
  const missedExposuresRef = useRef(0);
  const decodeFailuresRef = useRef(0);
  const rateSamplesRef = useRef<RateSample[]>([]);
  const deliverySamplesRef = useRef<DeliverySample[]>([]);
  const scanPerformanceRef = useRef<ScanPerformanceSample[]>([]);
  const lastPresentedFramesRef = useRef(0);
  const lastMetricsUpdateRef = useRef(0);
  const [state, setState] = useState<ScanState>("idle");
  const [scanMode, setScanMode] = useState<ScanMode>("single");
  const [progress, setProgress] = useState(0);
  const [frames, setFrames] = useState(0);
  const [qrReads, setQrReads] = useState(0);
  const [missedExposures, setMissedExposures] = useState(0);
  const [badFrames, setBadFrames] = useState(0);
  const [opticalRate, setOpticalRate] = useState(0);
  const [incoming, setIncoming] = useState<IncomingMeta>();
  const [fileMeta, setFileMeta] = useState<OpticalFileMeta>();
  const [downloadUrl, setDownloadUrl] = useState("");
  const [error, setError] = useState("");
  const [guidance, setGuidance] = useState(
    "Center the complete QR inside the four corners.",
  );
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraSettings, setCameraSettings] = useState<CameraSettings>();
  const [scanMetrics, setScanMetrics] = useState<ScanMetrics>({
    deliveredFps: 0,
    scannerFps: 0,
    decodeP50: 0,
    decodeP95: 0,
  });
  const [vaultBytes, setVaultBytes] = useState<Uint8Array | null>(null);
  const [vaultSecrets, setVaultSecrets] = useState<SecretEntry[] | null>(null);
  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [vaultError, setVaultError] = useState("");
  const [vaultDecrypting, setVaultDecrypting] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [showVaultPassphrase, setShowVaultPassphrase] = useState(false);

  const stopCamera = useCallback(() => {
    scanningRef.current = false;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
  }, []);

  const chooseScanMode = (nextMode: ScanMode) => {
    scanModeRef.current = nextMode;
    setScanMode(nextMode);
    setGuidance(
      nextMode === "dual"
        ? "Rotate the phone landscape and fit both complete QRs inside the guide."
        : "Center the complete QR inside the four corners.",
    );
  };

  const finishTransfer = useCallback(
    async (container: Uint8Array, session: ReceiverSession) => {
      if (completingRef.current) return;
      completingRef.current = true;
      try {
        setGuidance(
          session.compressed
            ? "Optical transfer complete. Decompressing and verifying…"
            : "Optical transfer complete. Verifying the file…",
        );
        if (
          container.length !== session.containerLength ||
          crc32(container) !== session.session
        ) {
          throw new Error("The recovered RaptorQ object failed its checksum.");
        }
        const recovered = parseOpticalContainer(container);
        const bytes = await decompressTransfer(
          recovered.transmitted,
          recovered.meta.compression,
        );
        if (
          bytes.length !== recovered.meta.fileSize ||
          crc32(bytes) !== recovered.meta.fileCrc
        ) {
          throw new Error("The recovered file checksum did not match.");
        }

        setFileMeta(recovered.meta);
        setProgress(1);
        setState("complete");
        stopCamera();
        navigator.vibrate?.([80, 40, 120]);

        if (recovered.meta.mime === VAULT_MIME) {
          setVaultBytes(bytes);
          setVaultSecrets(null);
          setVaultPassphrase("");
          setVaultError("");
          setRevealedKeys(new Set());
          setGuidance(
            isEncryptedVault(bytes)
              ? "Vault recovered. Enter the passphrase to reveal secrets."
              : "Unencrypted vault recovered. Secrets are ready to review.",
          );
          return;
        }

        const fileBytes = Uint8Array.from(bytes);
        const url = URL.createObjectURL(
          new Blob([fileBytes.buffer], { type: recovered.meta.mime }),
        );
        if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
        downloadUrlRef.current = url;
        setDownloadUrl(url);
        setGuidance("File decompressed and checksum verified. It is safe to save.");
      } catch (cause) {
        setState("error");
        setError(
          cause instanceof Error ? cause.message : "File verification failed.",
        );
        stopCamera();
      } finally {
        completingRef.current = false;
      }
    },
    [stopCamera],
  );

  const acceptQrBytes = useCallback(
    async (bytes: Uint8Array) => {
      qrReadsRef.current += 1;
      lastQrAtRef.current = performance.now();
      setQrReads(qrReadsRef.current);

      let frame;
      try {
        frame = parseOpticalFrame(bytes);
      } catch {
        const textPrefix = new TextDecoder().decode(bytes.subarray(0, 8));
        if (textPrefix.startsWith("QF2") || textPrefix.startsWith("QF3")) {
          setGuidance("An older QRFerry sender is visible. Reload the sending screen.");
          return;
        }
        setBadFrames((current) => current + 1);
        setGuidance("A frame was incomplete. Hold steady—the next one can replace it.");
        return;
      }

      let receiver = receiverRef.current;
      if (!receiver) {
        const { RaptorQWasmDecoder } = await import(
          "@raptorqr/core/fec/raptorq_wasm"
        );
        const decoder = await RaptorQWasmDecoder.create(
          frame.containerLength,
          frame.symbolSize,
        );
        receiver = {
          session: frame.session,
          containerLength: frame.containerLength,
          originalSize: frame.originalSize,
          compressed: frame.compressed,
          symbolSize: frame.symbolSize,
          sourcePacketCount: Math.max(
            1,
            Math.ceil(frame.containerLength / (frame.symbolSize - 4)),
          ),
          decoder,
          seen: new Set<string>(),
        };
        receiverRef.current = receiver;
        setIncoming({
          session: receiver.session,
          containerLength: receiver.containerLength,
          originalSize: receiver.originalSize,
          compressed: receiver.compressed,
          symbolSize: receiver.symbolSize,
          sourcePacketCount: receiver.sourcePacketCount,
        });
        setGuidance("RaptorQ locked. Keep the full white margin visible.");
        setState("receiving");
      }

      if (
        frame.session !== receiver.session ||
        frame.containerLength !== receiver.containerLength ||
        frame.symbolSize !== receiver.symbolSize
      ) {
        setGuidance("A different transfer crossed the camera view. Stay on one sender.");
        return;
      }

      const key = raptorPacketKey(frame);
      if (receiver.seen.has(key)) {
        setGuidance("Signal locked. Waiting for a new RaptorQ symbol.");
        return;
      }
      receiver.seen.add(key);
      acceptedFramesRef.current += 1;
      const accepted = acceptedFramesRef.current;
      const sourceBytes = Math.max(1, frame.symbolSize - 4);
      const rate = updateRollingRate(rateSamplesRef.current, sourceBytes);
      const estimatedProgress = Math.min(
        0.99,
        accepted / (receiver.sourcePacketCount + 2),
      );
      setFrames(accepted);
      setOpticalRate(rate);
      setProgress(estimatedProgress);
      setGuidance(
        frame.symbolSize > 2200
          ? "High-density stream locked. Keep the phone close, square, and completely still."
          : "Signal locked. RaptorQ is absorbing dropped exposures.",
      );
      setState("receiving");

      const decoded = receiver.decoder.push(frame.payload);
      if (decoded) await finishTransfer(decoded, receiver);
    },
    [finishTransfer],
  );

  const scanVideo = useCallback(
    function scanVideoFrame(metadata?: VideoFrameMetadataLike) {
      if (!scanningRef.current) return;
      const callbackAt = performance.now();
      const reportedFrames = metadata?.presentedFrames;
      const presentedFrames =
        typeof reportedFrames === "number" &&
        reportedFrames > lastPresentedFramesRef.current
          ? reportedFrames
          : lastPresentedFramesRef.current + 1;
      lastPresentedFramesRef.current = presentedFrames;
      const deliverySamples = deliverySamplesRef.current;
      deliverySamples.push({ at: callbackAt, frames: presentedFrames });
      while (
        deliverySamples.length > 2 &&
        callbackAt - deliverySamples[0].at > 3500
      ) {
        deliverySamples.shift();
      }

      let attempted = false;
      let decodeMs = 0;
      const runScan = async () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (
          !video ||
          !canvas ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          video.videoWidth === 0 ||
          video.videoHeight === 0
        ) {
          return;
        }

        const dualMode = scanModeRef.current === "dual";
        const availableWidth = video.videoWidth * 0.96;
        const availableHeight = video.videoHeight * 0.96;
        const sourceWidth = Math.floor(
          dualMode
            ? Math.min(availableWidth, availableHeight * 2)
            : Math.min(availableWidth, availableHeight),
        );
        const sourceHeight = dualMode
          ? Math.floor(sourceWidth / 2)
          : sourceWidth;
        const sourceX = Math.floor((video.videoWidth - sourceWidth) / 2);
        const sourceY = Math.floor((video.videoHeight - sourceHeight) / 2);
        const robustAttempt = decodeFailuresRef.current % 6 === 5;
        const highDensity =
          (receiverRef.current?.symbolSize ?? 0) > 2200;
        const scanWidth = Math.min(
          dualMode
            ? highDensity
              ? 1800
              : robustAttempt
                ? 1680
                : 1440
            : highDensity
              ? 1280
              : robustAttempt
                ? 1120
                : 960,
          sourceWidth,
        );
        const scanHeight = dualMode
          ? Math.max(1, Math.floor(scanWidth / 2))
          : scanWidth;
        canvas.width = scanWidth;
        canvas.height = scanHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.imageSmoothingEnabled = false;
        context.drawImage(
          video,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          scanWidth,
          scanHeight,
        );

        const image = context.getImageData(0, 0, scanWidth, scanHeight);
        const { scanRawQr, scanRawQrs } = await import("@/lib/qr-scanner");
        attempted = true;
        const decodeStartedAt = performance.now();
        let decodedFrames: Uint8Array[];
        try {
          if (dualMode) {
            decodedFrames = await scanRawQrs(image, robustAttempt, 2);
          } else {
            const decoded = await scanRawQr(image, robustAttempt);
            decodedFrames = decoded ? [decoded] : [];
          }
        } finally {
          decodeMs = performance.now() - decodeStartedAt;
        }

        if (decodedFrames.length === 0) {
          decodeFailuresRef.current += 1;
          missedExposuresRef.current += 1;
          if (missedExposuresRef.current % 5 === 0) {
            setMissedExposures(missedExposuresRef.current);
          }
          return;
        }
        decodeFailuresRef.current = 0;
        for (const decoded of decodedFrames) {
          await acceptQrBytes(decoded);
        }
      };

      void runScan()
        .catch(() => {
          decodeFailuresRef.current += 1;
          missedExposuresRef.current += 1;
        })
        .finally(() => {
          if (!scanningRef.current) return;
          const finishedAt = performance.now();
          if (attempted) {
            const performanceSamples = scanPerformanceRef.current;
            performanceSamples.push({ at: finishedAt, decodeMs });
            while (
              performanceSamples.length > 2 &&
              finishedAt - performanceSamples[0].at > 3500
            ) {
              performanceSamples.shift();
            }

            if (finishedAt - lastMetricsUpdateRef.current >= 500) {
              const firstDelivery = deliverySamples[0];
              const lastDelivery =
                deliverySamples[deliverySamples.length - 1];
              const deliveryElapsed =
                lastDelivery && firstDelivery
                  ? lastDelivery.at - firstDelivery.at
                  : 0;
              const deliveredFps =
                deliveryElapsed > 0
                  ? ((lastDelivery.frames - firstDelivery.frames) * 1000) /
                    deliveryElapsed
                  : 0;
              const firstScan = performanceSamples[0];
              const lastScan =
                performanceSamples[performanceSamples.length - 1];
              const scanElapsed =
                lastScan && firstScan ? lastScan.at - firstScan.at : 0;
              const scannerFps =
                scanElapsed > 0
                  ? ((performanceSamples.length - 1) * 1000) / scanElapsed
                  : 0;
              const decodeValues = performanceSamples.map(
                (sample) => sample.decodeMs,
              );
              setScanMetrics({
                deliveredFps,
                scannerFps,
                decodeP50: percentile(decodeValues, 0.5),
                decodeP95: percentile(decodeValues, 0.95),
              });
              lastMetricsUpdateRef.current = finishedAt;
            }
          }

          const video = videoRef.current as VideoWithFrameCallback | null;
          if (video?.requestVideoFrameCallback) {
            video.requestVideoFrameCallback((_now, nextMetadata) =>
              scanVideoFrame(nextMetadata),
            );
          } else {
            window.requestAnimationFrame(() => scanVideoFrame());
          }
        });
    },
    [acceptQrBytes],
  );

  const startCamera = useCallback(async () => {
    setError("");
    setGuidance(
      scanModeRef.current === "dual"
        ? "Rotate the phone landscape and fit both complete QRs inside the guide."
        : "Center the complete QR inside the four corners.",
    );
    setState("starting");
    receiverRef.current = undefined;
    completingRef.current = false;
    qrReadsRef.current = 0;
    acceptedFramesRef.current = 0;
    missedExposuresRef.current = 0;
    decodeFailuresRef.current = 0;
    rateSamplesRef.current = [];
    deliverySamplesRef.current = [];
    scanPerformanceRef.current = [];
    lastPresentedFramesRef.current = 0;
    lastMetricsUpdateRef.current = 0;
    lastQrAtRef.current = 0;
    scanStartedAtRef.current = performance.now();
    setIncoming(undefined);
    setFileMeta(undefined);
    setProgress(0);
    setFrames(0);
    setQrReads(0);
    setMissedExposures(0);
    setBadFrames(0);
    setOpticalRate(0);
    setTorchOn(false);
    setCameraSettings(undefined);
    setScanMetrics({
      deliveredFps: 0,
      scannerFps: 0,
      decodeP50: 0,
      decodeP95: 0,
    });
    setVaultBytes(null);
    setVaultSecrets(null);
    setVaultPassphrase("");
    setVaultError("");
    setVaultDecrypting(false);
    setRevealedKeys(new Set());
    setShowVaultPassphrase(false);
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = "";
      setDownloadUrl("");
    }

    try {
      const decoderLoad = import("@/lib/qr-scanner").then(({ prepareQrScanner }) =>
        prepareQrScanner(),
      );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60, min: 24 },
        },
      });
      await decoderLoad;
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      setCameraSettings({
        width: settings.width ?? 0,
        height: settings.height ?? 0,
        frameRate: settings.frameRate ?? 0,
      });
      const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & {
        focusMode?: string[];
        torch?: boolean;
      };
      setTorchAvailable(Boolean(capabilities?.torch));
      if (capabilities?.focusMode?.includes("continuous")) {
        await track
          .applyConstraints({
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          })
          .catch(() => undefined);
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      scanningRef.current = true;
      setState("scanning");
      const video = videoRef.current as VideoWithFrameCallback | null;
      if (video?.requestVideoFrameCallback) {
        video.requestVideoFrameCallback((_now, metadata) =>
          scanVideo(metadata),
        );
      } else {
        window.requestAnimationFrame(() => scanVideo());
      }
    } catch (cause) {
      stopCamera();
      setState("error");
      const name = cause instanceof DOMException ? cause.name : "";
      setError(
        name === "NotAllowedError"
          ? "Camera access was blocked. Allow camera access in your browser settings and try again."
          : "The rear camera could not be started. Camera scanning needs HTTPS or localhost.",
      );
    }
  }, [scanVideo, stopCamera]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!scanningRef.current || acceptedFramesRef.current > 0) return;
      const now = performance.now();
      if (lastQrAtRef.current > 0 && now - lastQrAtRef.current < 3000) return;
      const elapsed = now - scanStartedAtRef.current;
      if (elapsed > 8000) {
        setGuidance(
          scanModeRef.current === "dual"
            ? "No lane decoded. Confirm Dual lane on both devices, rotate landscape, and move closer."
            : "No frame decoded. Use Robust mode, move closer, and keep the white margin visible.",
        );
      } else if (elapsed > 4000) {
        setGuidance(
          scanModeRef.current === "dual"
            ? "Still looking. Keep both white margins visible and hold the phone square to the screen."
            : "Still looking. Move closer until the single QR nearly fills the guide.",
        );
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    };
  }, [stopCamera]);

  useEffect(() => {
    if (!vaultBytes || isEncryptedVault(vaultBytes) || vaultSecrets) return;
    try {
      setVaultSecrets(bytesToSecrets(vaultBytes));
      setVaultError("");
    } catch (cause) {
      setVaultError(
        cause instanceof Error
          ? cause.message
          : "The vault payload could not be decoded.",
      );
    }
  }, [vaultBytes, vaultSecrets]);

  const unlockVault = async () => {
    if (!vaultBytes) return;
    setVaultDecrypting(true);
    setVaultError("");
    try {
      const plaintext = await decryptSecrets(vaultBytes, vaultPassphrase);
      setVaultSecrets(bytesToSecrets(plaintext));
      setRevealedKeys(new Set());
      setGuidance("Vault unlocked. Review secrets carefully before copying.");
    } catch (cause) {
      setVaultSecrets(null);
      setVaultError(
        cause instanceof Error
          ? cause.message
          : "The vault could not be decrypted.",
      );
    } finally {
      setVaultDecrypting(false);
    }
  };

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard?.writeText(value);
    } catch {
      setVaultError("Clipboard access failed. Copy manually or use HTTPS.");
    }
  };

  const clearVaultSecrets = () => {
    setVaultPassphrase("");
    setVaultError("");
    setRevealedKeys(new Set());
    setGuidance("Secrets cleared from this screen.");
    if (vaultBytes && isEncryptedVault(vaultBytes)) {
      setVaultSecrets(null);
    } else {
      setVaultSecrets([]);
    }
  };

  const downloadEnv = () => {
    if (!vaultSecrets) return;
    const text = serializeEnv(vaultSecrets);
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileMeta?.filename || "qrvault.env";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const complete = state === "complete";
  const vaultComplete = complete && vaultBytes !== null;
  const active =
    state === "scanning" || state === "receiving" || state === "starting";
  const compressionRatio =
    incoming && incoming.containerLength > 0
      ? incoming.originalSize / incoming.containerLength
      : 1;
  const effectiveRate = opticalRate * compressionRatio;
  const recoveredBytes = incoming
    ? Math.min(
        incoming.containerLength,
        frames * Math.max(1, incoming.symbolSize - 4),
      )
    : 0;
  const etaSeconds =
    incoming && opticalRate > 0
      ? (incoming.containerLength - recoveredBytes) / opticalRate
      : Number.POSITIVE_INFINITY;
  const compressionPercent =
    incoming && incoming.originalSize > 0
      ? Math.max(
          0,
          Math.round(
            (1 - incoming.containerLength / incoming.originalSize) * 100,
          ),
        )
      : 0;

  return (
    <main className="scanner-page">
      <section className="scanner-intro">
        <p className="eyebrow">RAPTORQ MOBILE RECEIVER</p>
        <h1>
          {vaultComplete
            ? "Vault recovered."
            : complete
              ? "File recovered."
              : "Point. Hold. Receive."}
        </h1>
        <p>
          {vaultComplete
            ? vaultSecrets
              ? "Secrets verified. Reveal only what you need, then clear the screen."
              : "The optical payload passed checksums. Unlock with the sender passphrase."
            : complete
              ? "The RaptorQ object and original file both passed end-to-end checksums."
              : scanMode === "dual"
                ? "Dual-lane scanning reads two alternating 30 fps channels; either stable lane can advance the file."
                : "A native-speed scanner reads one raw-binary QR per exposure; missed frames do not matter."}
        </p>
      </section>

      <section className="scanner-shell">
        <div className={`camera-view ${scanMode} ${active ? "active" : ""} ${complete ? "complete" : ""}`}>
          <video ref={videoRef} playsInline muted aria-label="Rear camera preview" />
          <canvas ref={canvasRef} hidden />
          <div className="scan-reticle" aria-hidden="true">
            <i /><i /><i /><i />
          </div>
          {!active && !complete ? (
            <div className="camera-empty">
              <span className="camera-icon" aria-hidden="true">◎</span>
              <strong>Camera is off</strong>
              <span>
                {scanMode === "dual"
                  ? "Dual lane selected · rotate landscape."
                  : "The video stays on this device."}
              </span>
            </div>
          ) : null}
          {state === "starting" ? <div className="camera-loading">Loading optical decoder…</div> : null}
          {complete ? <div className="complete-mark" aria-hidden="true">✓</div> : null}
          {torchAvailable && active ? (
            <button className="torch-button" type="button" onClick={toggleTorch}>
              {torchOn ? "Light off" : "Light on"}
            </button>
          ) : null}
        </div>

        <div className="receive-card">
          <div className="receive-status">
            <span className={`pulse-dot ${active ? "live" : ""}`} aria-hidden="true" />
            <strong>
              {state === "receiving"
                ? "Receiving RaptorQ symbols"
                : state === "scanning"
                  ? "Looking for QRFerry"
                  : complete
                    ? "Transfer verified"
                    : "Ready to scan"}
            </strong>
            <b>{Math.round(progress * 100)}%</b>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="File recovery progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span style={{ width: `${progress * 100}%` }} />
          </div>

          <div
            className="scan-mode-picker"
            role="radiogroup"
            aria-label="Scanner layout"
          >
            <button
              type="button"
              role="radio"
              aria-checked={scanMode === "single"}
              className={scanMode === "single" ? "selected" : ""}
              disabled={active}
              onClick={() => chooseScanMode("single")}
            >
              Single QR
              <small>Robust through Turbo 30</small>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scanMode === "dual"}
              className={scanMode === "dual" ? "selected" : ""}
              disabled={active}
              onClick={() => chooseScanMode("dual")}
            >
              Dual lane
              <small>Turbo 60 and 1 Mbps lab</small>
            </button>
          </div>

          <div className="rate-panel" aria-live="polite">
            <div>
              <span>Effective file rate</span>
              <strong>{effectiveRate > 0 ? formatRate(effectiveRate) : "—"}</strong>
              <small>
                {incoming?.compressed
                  ? `${formatRate(opticalRate)} optical · ${compressionPercent}% compressed`
                  : `${formatRate(opticalRate)} accepted optical data`}
              </small>
            </div>
            <div>
              <span>Estimated remaining</span>
              <strong>{complete ? "Complete" : formatEta(etaSeconds)}</strong>
              <small>
                {incoming
                  ? `${formatBytes(recoveredBytes)} of ${formatBytes(incoming.containerLength)} encoded`
                  : "Waiting for first RaptorQ symbol"}
              </small>
            </div>
          </div>

          {incoming ? (
            <div className="incoming-file">
              <span className="file-glyph" aria-hidden="true">↓</span>
              <div>
                <strong>{fileMeta?.filename || "Incoming file"}</strong>
                <span>
                  {formatBytes(incoming.originalSize)}
                  {incoming.compressed ? ` · ${compressionPercent}% compression` : ""}
                  {" · "}
                  {frames.toLocaleString()} / ~{incoming.sourcePacketCount.toLocaleString()} symbols
                </span>
              </div>
              <b>RQ</b>
            </div>
          ) : null}

          <div
            className="scan-diagnostics channel-diagnostics"
            aria-label="Live camera and decoder performance"
          >
            <span>
              <b>
                {cameraSettings?.frameRate
                  ? cameraSettings.frameRate.toFixed(0)
                  : "—"}{" "}
                fps
              </b>
              negotiated
            </span>
            <span>
              <b>
                {scanMetrics.deliveredFps
                  ? scanMetrics.deliveredFps.toFixed(1)
                  : "—"}{" "}
                fps
              </b>
              delivered
            </span>
            <span>
              <b>
                {scanMetrics.scannerFps
                  ? scanMetrics.scannerFps.toFixed(1)
                  : "—"}{" "}
                fps
              </b>
              scanner
            </span>
            <span>
              <b>
                {scanMetrics.decodeP50
                  ? `${scanMetrics.decodeP50.toFixed(0)} / ${scanMetrics.decodeP95.toFixed(0)} ms`
                  : "—"}
              </b>
              decode p50 / p95
            </span>
          </div>
          <div className="scan-diagnostics" aria-live="polite">
            <span><b>{qrReads}</b> QR reads</span>
            <span><b>{frames}</b> unique</span>
            <span><b>{missedExposures}</b> missed</span>
            <span><b>{badFrames}</b> rejected</span>
          </div>
          <p className="scan-hint">{guidance}</p>

          {error ? <p className="error-message" role="alert">{error}</p> : null}

          {vaultComplete ? (
            <div className="secrets-output">
              {vaultBytes && isEncryptedVault(vaultBytes) && !vaultSecrets ? (
                <div className="vault-decrypt-gate">
                  <label>
                    Vault passphrase
                    <div className="vault-passphrase-row">
                      <input
                        type={showVaultPassphrase ? "text" : "password"}
                        value={vaultPassphrase}
                        onChange={(event) =>
                          setVaultPassphrase(event.target.value)
                        }
                        autoComplete="current-password"
                        disabled={vaultDecrypting}
                      />
                      <button
                        type="button"
                        className="secret-reveal-btn"
                        onClick={() =>
                          setShowVaultPassphrase((current) => !current)
                        }
                      >
                        {showVaultPassphrase ? "Hide" : "Show"}
                      </button>
                    </div>
                  </label>
                  <button
                    className="primary-action"
                    type="button"
                    disabled={!vaultPassphrase || vaultDecrypting}
                    onClick={() => void unlockVault()}
                  >
                    <span aria-hidden="true">
                      {vaultDecrypting ? "…" : "⊘"}
                    </span>
                    {vaultDecrypting ? "Decrypting…" : "Unlock secrets"}
                  </button>
                </div>
              ) : null}

              {vaultSecrets && vaultSecrets.length > 0 ? (
                <>
                  <table className="secrets-table">
                    <thead>
                      <tr>
                        <th scope="col">Key</th>
                        <th scope="col">Value</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vaultSecrets.map((entry) => {
                        const revealed = revealedKeys.has(entry.key);
                        return (
                          <tr key={entry.key}>
                            <td>
                              <code>{entry.key}</code>
                            </td>
                            <td>
                              <code>
                                {revealed ? entry.value : "••••••••"}
                              </code>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="secret-reveal-btn"
                                onClick={() =>
                                  setRevealedKeys((current) => {
                                    const next = new Set(current);
                                    if (next.has(entry.key)) next.delete(entry.key);
                                    else next.add(entry.key);
                                    return next;
                                  })
                                }
                              >
                                {revealed ? "Hide" : "Reveal"}
                              </button>
                              <button
                                type="button"
                                className="secret-reveal-btn"
                                onClick={() => void copyText(entry.value)}
                              >
                                Copy
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="secrets-actions">
                    <button
                      type="button"
                      className="link-action"
                      onClick={() => void copyText(serializeEnv(vaultSecrets))}
                    >
                      Copy all as .env
                    </button>
                    <button
                      type="button"
                      className="link-action"
                      onClick={downloadEnv}
                    >
                      Download .env
                    </button>
                    <button
                      type="button"
                      className="link-action"
                      onClick={clearVaultSecrets}
                    >
                      Clear secrets
                    </button>
                  </div>
                </>
              ) : null}

              {vaultSecrets && vaultSecrets.length === 0 ? (
                <p className="scan-hint">Secrets cleared from this screen.</p>
              ) : null}

              {vaultError ? (
                <p className="error-message" role="alert">
                  {vaultError}
                </p>
              ) : null}

              <button className="link-action" type="button" onClick={startCamera}>
                Scan another transfer
              </button>
            </div>
          ) : complete && downloadUrl && fileMeta ? (
            <a className="primary-action" href={downloadUrl} download={fileMeta.filename}>
              <span aria-hidden="true">↓</span>
              Save {fileMeta.filename}
            </a>
          ) : (
            <button
              className="primary-action"
              type="button"
              disabled={state === "starting"}
              onClick={
                active
                  ? () => {
                      stopCamera();
                      setState("idle");
                      setGuidance("Camera stopped. Start it again when ready.");
                    }
                  : startCamera
              }
            >
              <span aria-hidden="true">{active ? "■" : "◎"}</span>
              {state === "starting" ? "Loading…" : active ? "Stop camera" : "Start camera"}
            </button>
          )}

          {complete && !vaultComplete ? (
            <button className="link-action" type="button" onClick={startCamera}>
              Scan another transfer
            </button>
          ) : null}
        </div>
      </section>

      <section className="scan-tips">
        <div><span>1</span><p>Turbo 60 requires Dual lane on the reader and a landscape phone view containing both complete QRs.</p></div>
        <div><span>2</span><p>Only one lane changes per refresh, leaving the other clean through rolling-shutter transitions.</p></div>
        <div><span>3</span><p>If neither lane locks, use fullscreen, move closer, or return to single-lane Turbo 30.</p></div>
      </section>
    </main>
  );
}
