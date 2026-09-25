import { gcm } from "@noble/ciphers/aes.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

const LIMIT = 20 * 1024 * 1024;
export const MAX_ENCRYPTED_SIZE = LIMIT * 2 + 4096;
const ITERATIONS = 600000;
const header = new TextEncoder().encode(
  "macro-track-encrypted-backup:v1:pbkdf2-sha256:600000:aes-256-gcm"
);
const envelope = z.strictObject({
  format: z.literal("macro-track-encrypted-backup"),
  version: z.literal(1),
  kdf: z.literal("pbkdf2-sha256"),
  iterations: z.literal(ITERATIONS),
  cipher: z.literal("aes-256-gcm"),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  nonce: z.string().regex(/^[a-f0-9]{24}$/),
  ciphertext: z
    .string()
    .min(32)
    .max((LIMIT + 16) * 2)
    .regex(/^[a-f0-9]+$/)
    .refine((value) => value.length % 2 === 0),
});
function checkPassword(password: string) {
  if (password.length < 10 || password.length > 256)
    throw new Error("Use a password between 10 and 256 characters.");
}
export async function encryptBackupText(
  text: string,
  password: string,
  randomBytes: (length: number) => Promise<Uint8Array>
): Promise<string> {
  checkPassword(password);
  const plain = new TextEncoder().encode(text);
  if (plain.length > LIMIT) throw new Error("Backup data exceeds the 20 MB limit.");
  const salt = await randomBytes(16);
  const nonce = await randomBytes(12);
  if (salt.length !== 16 || nonce.length !== 12)
    throw new Error("Secure random generation failed.");
  const key = await pbkdf2Async(sha256, password, salt, { c: ITERATIONS, dkLen: 32, asyncTick: 8 });
  try {
    const ciphertext = gcm(key, nonce, header).encrypt(plain);
    return JSON.stringify({
      format: "macro-track-encrypted-backup",
      version: 1,
      kdf: "pbkdf2-sha256",
      iterations: ITERATIONS,
      cipher: "aes-256-gcm",
      salt: bytesToHex(salt),
      nonce: bytesToHex(nonce),
      ciphertext: bytesToHex(ciphertext),
    });
  } finally {
    key.fill(0);
    plain.fill(0);
  }
}
export async function decryptBackupText(text: string, password: string): Promise<string> {
  checkPassword(password);
  if (text.length > MAX_ENCRYPTED_SIZE) throw new Error("This backup is too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This is not a readable Macro Track backup.");
  }
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) throw new Error("This is not a supported encrypted Macro Track backup.");
  const data = parsed.data;
  const key = await pbkdf2Async(sha256, password, hexToBytes(data.salt), {
    c: ITERATIONS,
    dkLen: 32,
    asyncTick: 8,
  });
  let plain: Uint8Array | undefined;
  try {
    plain = gcm(key, hexToBytes(data.nonce), header).decrypt(hexToBytes(data.ciphertext));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("Wrong password or damaged backup. Nothing was restored.");
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}
