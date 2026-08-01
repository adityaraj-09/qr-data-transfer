export type SecretEntry = {
  key: string;
  value: string;
};

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stripOuterQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnv(text: string): SecretEntry[] {
  const secrets: SecretEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals <= 0) continue;

    let key = line.slice(0, equals).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!KEY_PATTERN.test(key) || seen.has(key)) continue;

    const value = stripOuterQuotes(line.slice(equals + 1).trim());
    seen.add(key);
    secrets.push({ key, value });
  }

  return secrets;
}

export function serializeEnv(secrets: SecretEntry[]): string {
  return secrets
    .filter((entry) => KEY_PATTERN.test(entry.key))
    .map((entry) => {
      const needsQuotes =
        entry.value === "" ||
        /[\s#"']/.test(entry.value) ||
        entry.value.includes("=");
      if (!needsQuotes) return `${entry.key}=${entry.value}`;
      const escaped = entry.value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      return `${entry.key}="${escaped}"`;
    })
    .join("\n");
}

export function secretsToBytes(secrets: SecretEntry[]): Uint8Array {
  const normalized = secrets.map((entry) => ({
    key: entry.key,
    value: entry.value,
  }));
  return new TextEncoder().encode(JSON.stringify(normalized));
}

export function bytesToSecrets(bytes: Uint8Array): SecretEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Vault payload is not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Vault payload must be a JSON array of secrets.");
  }

  const secrets: SecretEntry[] = [];
  for (const item of parsed) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as SecretEntry).key !== "string" ||
      typeof (item as SecretEntry).value !== "string"
    ) {
      throw new Error("Vault payload contains an invalid secret entry.");
    }
    const key = (item as SecretEntry).key;
    const value = (item as SecretEntry).value;
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`Vault secret key is invalid: ${key}`);
    }
    secrets.push({ key, value });
  }
  return secrets;
}

export function maskSecretValue(value: string) {
  if (value.length <= 2) return "••••••••";
  return "••••••••";
}

export function formatMaskedPreview(secrets: SecretEntry[]) {
  if (secrets.length === 0) return "No secrets yet";
  return secrets
    .map((entry) => `${entry.key}=${maskSecretValue(entry.value)}`)
    .join(" ");
}
