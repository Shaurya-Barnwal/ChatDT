// web/src/utils/crypto.js
// deterministic, cross-browser Web Crypto helpers
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Accept many input shapes for iv/ciphertext:
// - base64 string
// - Buffer-like object { type: "Buffer", data: [...] }
// - Uint8Array or ArrayBuffer
function normalizeToArrayBuffer(input) {
  if (!input && input !== 0) return null;
  // already ArrayBuffer or TypedArray
  if (input instanceof ArrayBuffer) return input;
  if (ArrayBuffer.isView(input)) return input.buffer;
  // If it's a Buffer-like object from JSON (e.g. { type: "Buffer", data: [...] })
  if (typeof input === "object" && Array.isArray(input.data)) {
    return new Uint8Array(input.data).buffer;
  }
  // If it's a base64 string
  if (typeof input === "string") {
    return fromBase64(input);
  }
  // Unknown shape: try to JSON inspect
  throw new Error("Unsupported input type for crypto normalizer: " + typeof input);
}

export async function deriveKey(passphrase, roomId) {
  const passBytes = textEncoder.encode(String(passphrase || ""));
  const salt = textEncoder.encode(String(roomId || "default-room"));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passBytes,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  // NOTE: make extractable=true so exportKeyBase64 can export raw bytes for fingerprinting.
  // If you want to lock this down later, set extractable=false (but then exportKeyBase64 won't work).
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 200000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true, // <--- extractable true (so we can export for fingerprint/debug)
    ["encrypt", "decrypt"]
  );

  return key;
}

export async function encryptText(key, plainText) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 12 bytes IV
  const pt = textEncoder.encode(plainText);
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    pt
  );
  return {
    iv: toBase64(iv.buffer),
    ciphertext: toBase64(cipherBuffer),
  };
}

export async function decryptText(key, ivInput, ciphertextInput) {
  // accepts iv/ciphertext as base64 OR Buffer-like object OR ArrayBuffer/Uint8Array
  try {
    const ivBuf = normalizeToArrayBuffer(ivInput);
    const cipherBuf = normalizeToArrayBuffer(ciphertextInput);
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(ivBuf) },
      key,
      cipherBuf
    );
    return textDecoder.decode(new Uint8Array(plainBuf));
  } catch (err) {
    // rethrow with more context for easier debugging
    throw new Error("decrypt failed: " + (err && err.message ? err.message : String(err)));
  }
}

// Helper: export raw key bytes (for fingerprinting)
// May fail if key isn't extractable; callers should catch.
export async function exportKeyBase64(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64(raw);
}

// compute a deterministic fingerprint from passphrase + roomId (no key export)
export async function computeFingerprint(passphrase, roomId) {
  // Combine passphrase and roomId with a separator to avoid accidental collisions
  const data = textEncoder.encode(String(passphrase || "") + "|" + String(roomId || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  // digest is an ArrayBuffer — toBase64 handles ArrayBuffer
  // Return a short, display-friendly substring (first 12 chars)
  return toBase64(digest).slice(0, 12);
}