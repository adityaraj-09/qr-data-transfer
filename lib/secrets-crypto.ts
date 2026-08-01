export const VAULT_MIME = "application/x-qrferry-vault";

const MAGIC = new TextEncoder().encode("VLTK");
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 200_000;
const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES;

function requireCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is unavailable in this environment.");
  }
  return globalThis.crypto;
}

function getRandomBytes(length: number) {
  const bytes = new Uint8Array(length);
  requireCrypto().getRandomValues(bytes);
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array) {
  const crypto = requireCrypto();
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function isEncryptedVault(bytes: Uint8Array) {
  if (bytes.length < HEADER_BYTES + 16) return false;
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) return false;
  }
  return bytes[MAGIC.length] === VERSION;
}

export async function encryptSecrets(
  plaintext: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  if (!passphrase) {
    throw new Error("A passphrase is required to encrypt vault secrets.");
  }

  const crypto = requireCrypto();
  const salt = getRandomBytes(SALT_BYTES);
  const iv = getRandomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );

  const output = new Uint8Array(HEADER_BYTES + ciphertext.length);
  output.set(MAGIC, 0);
  output[MAGIC.length] = VERSION;
  output.set(salt, MAGIC.length + 1);
  output.set(iv, MAGIC.length + 1 + SALT_BYTES);
  output.set(ciphertext, HEADER_BYTES);
  return output;
}

export async function decryptSecrets(
  bytes: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  if (!isEncryptedVault(bytes)) {
    throw new Error("This payload is not an encrypted QRVault package.");
  }
  if (!passphrase) {
    throw new Error("Enter the passphrase used when this vault was created.");
  }

  const crypto = requireCrypto();
  const salt = bytes.slice(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
  const iv = bytes.slice(
    MAGIC.length + 1 + SALT_BYTES,
    MAGIC.length + 1 + SALT_BYTES + IV_BYTES,
  );
  const ciphertext = bytes.slice(HEADER_BYTES);
  const key = await deriveKey(passphrase, salt);

  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext),
    );
  } catch {
    throw new Error("Wrong passphrase, or the vault payload is corrupted.");
  }
}

/** Rough passphrase entropy estimate in bits (dictionary-aware enough for UI). */
export function estimatePassphraseEntropy(passphrase: string) {
  if (!passphrase) return 0;

  let pool = 0;
  if (/[a-z]/.test(passphrase)) pool += 26;
  if (/[A-Z]/.test(passphrase)) pool += 26;
  if (/\d/.test(passphrase)) pool += 10;
  if (/[^A-Za-z0-9]/.test(passphrase)) pool += 33;

  const unique = new Set(passphrase).size;
  const diversity = Math.min(1, unique / Math.max(1, passphrase.length));
  const bitsPerChar = Math.log2(Math.max(2, pool)) * (0.65 + 0.35 * diversity);
  return Math.round(passphrase.length * bitsPerChar);
}

export type PassphraseStrength = "weak" | "fair" | "strong";

export function passphraseStrength(passphrase: string): {
  bits: number;
  level: PassphraseStrength;
  label: string;
} {
  const bits = estimatePassphraseEntropy(passphrase);
  if (bits < 40) return { bits, level: "weak", label: "Weak" };
  if (bits < 70) return { bits, level: "fair", label: "Fair" };
  return { bits, level: "strong", label: "Strong" };
}
