// web/src/utils/crypto.js
// Browser-side Web Crypto helpers for PBKDF2 + AES-GCM encryption
// Exports: deriveKey, encryptText, decryptText, base64FromArrayBuffer

const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64FromArrayBuffer(buf) {
  // ArrayBuffer or Uint8Array -> base64
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function arrayBufferFromBase64(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Derive an AES-GCM 256-bit key from a passphrase and salt (both strings)
 * @param {string} passphrase
 * @param {string} salt
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(passphrase, salt) {
  if (!passphrase) throw new Error('passphrase required');
  if (!salt) salt = ''; // allow empty salt if needed

  const pwKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations: 120000, // good compromise for browsers
      hash: 'SHA-256'
    },
    pwKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  return key;
}

/**
 * Encrypt a string using a CryptoKey (AES-GCM). Returns base64 iv and ciphertext.
 * @param {CryptoKey} key
 * @param {string} plaintext
 * @returns {Promise<{iv: string, ciphertext: string}>}
 */
export async function encryptText(key, plaintext) {
  if (!key) throw new Error('key required');
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit iv recommended for AES-GCM
  const plainBytes = enc.encode(plaintext);

  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plainBytes
  );

  return {
    iv: base64FromArrayBuffer(iv.buffer),
    ciphertext: base64FromArrayBuffer(ct)
  };
}

/**
 * Decrypts a base64 iv + base64 ciphertext using the CryptoKey and returns plaintext string.
 * @param {CryptoKey} key
 * @param {string} ivBase64
 * @param {string} ciphertextBase64
 * @returns {Promise<string>}
 */
export async function decryptText(key, ivBase64, ciphertextBase64) {
  if (!key) throw new Error('key required');
  if (!ivBase64 || !ciphertextBase64) throw new Error('iv/ciphertext required');

  const ivBuf = arrayBufferFromBase64(ivBase64);
  const ctBuf = arrayBufferFromBase64(ciphertextBase64);

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBuf) },
    key,
    ctBuf
  );

  return dec.decode(plainBuf);
}