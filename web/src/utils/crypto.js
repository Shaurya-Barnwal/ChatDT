// web/src/utils/crypto.js
// deterministic, cross-browser Web Crypto helpers
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64(buf) {
  // buf: ArrayBuffer or Uint8Array
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

export async function deriveKey(passphrase, roomId) {
  // passphrase: string
  // roomId: string (used as salt)
  // returns an AES-GCM CryptoKey
  const passBytes = textEncoder.encode(passphrase);
  const salt = textEncoder.encode(roomId || "default-room");
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passBytes,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  // 200k iterations — reasonable for client KDF. Can lower if too slow.
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 200000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  return key;
}

export async function encryptText(key, plainText) {
  // key: CryptoKey from deriveKey
  // plainText: string
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV recommended for AES-GCM
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

export async function decryptText(key, ivBase64, ciphertextBase64) {
  // Note the signature: (key, iv, ciphertext)
  // ivBase64 & ciphertextBase64 are base64 strings
  const ivBuf = fromBase64(ivBase64);
  const cipherBuf = fromBase64(ciphertextBase64);
  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(ivBuf) },
      key,
      cipherBuf
    );
    return textDecoder.decode(new Uint8Array(plainBuf));
  } catch (err) {
    // bubble up error for caller to log
    throw new Error("decrypt failed: " + err.message);
  }
}

// Helper: export raw key bytes (for fingerprinting)
export async function exportKeyBase64(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64(raw);
}