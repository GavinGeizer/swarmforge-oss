const encoder = new TextEncoder();
export function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function decode(text: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > 4096)
    throw new Error("Invalid encoded value");
  return Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
export function token(bytes = 32) {
  return encode(crypto.getRandomValues(new Uint8Array(bytes)));
}
export async function hash(text: string) {
  return encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
}
async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function sign(secret: string, text: string) {
  return encode(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(text)),
    ),
  );
}
export async function verify(secret: string, text: string, signature: string) {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      decode(signature),
      encoder.encode(text),
    );
  } catch {
    return false;
  }
}
async function cipherKey(secret: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`swarmforge:oauth-encryption:${secret}`),
  );
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(secret: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await cipherKey(secret),
      encoder.encode(value),
    ),
  );
  return `${encode(iv)}.${encode(cipher)}`;
}
export async function open(secret: string, value: string) {
  const [iv, data, ...rest] = value.split(".");
  if (!iv || !data || rest.length) throw new Error("Invalid verifier");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(iv) },
      await cipherKey(secret),
      decode(data),
    ),
  );
}
