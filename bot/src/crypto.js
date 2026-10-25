import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "./config.js";

const KEY = Buffer.from(config.jwtEncryptKey || "", "hex");

// шифрование JWT (AES-256-GCM)
export function encryptJWT(jwt) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(jwt, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

// расшифровка JWT
export function decryptJWT(encrypted) {
  try {
    const data = Buffer.from(encrypted, "base64");
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encryptedData = data.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
