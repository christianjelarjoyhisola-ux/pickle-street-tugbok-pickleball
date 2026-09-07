/** Compare secrets without an early return based on matching prefix. */
export async function secretsMatch(
  actual: string | null,
  expected: string,
): Promise<boolean> {
  if (!actual || !expected) return false;
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualHash);
  const right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

export function jwtAssuranceLevel(token: string): "aal1" | "aal2" | null {
  try {
    const payloadPart = token.split(".")[1] ?? "";
    const padded = payloadPart.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - payloadPart.length % 4) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    return payload.aal === "aal2"
      ? "aal2"
      : payload.aal === "aal1"
      ? "aal1"
      : null;
  } catch {
    return null;
  }
}

/** Reject short, placeholder-like, or trivially repetitive internal secrets. */
export function requireHighEntropySecret(
  name: string,
  value: string | undefined,
): string {
  const secret = String(value ?? "").trim();
  const uniqueCharacters = new Set(secret).size;
  if (
    secret.length < 32 || uniqueCharacters < 12 ||
    /replace|example|password|secret123|^(.)\1+$/i.test(secret)
  ) {
    throw new Error(`${name} is not configured securely.`);
  }
  return secret;
}
