/**
 * Sponsor report tokens (RB2): 32 random bytes, base64url (43 chars, no
 * padding). The token is returned once; only its SHA-256 (hex) is stored.
 */
export const REPORT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newReportToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}
