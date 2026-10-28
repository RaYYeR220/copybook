/**
 * Scrubs anything that must not leave the process: configured endpoint URLs (they may carry API keys),
 * any other URL, and anything shaped like a private key (64 hex digits, with or without 0x).
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "[url]")
    .replace(/(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "[hex64]");
}
