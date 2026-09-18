import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { DatabaseConnection } from "./db.js";
import { digestToken } from "./security.js";
import { basePathHref } from "../shared/basePath.js";

export interface ActiveShareLink {
  id: string;
  project_id: string;
  permission: "read";
  created_at: string;
  token_ciphertext: string;
}

/**
 * Share URLs are bearer credentials. Keep only a digest for lookup and an
 * encrypted copy for the owner-facing list, so a database dump cannot be
 * used directly as a project credential.
 */
export function createShareLinkSecret(config: Config): { token: string; tokenHash: string; tokenCiphertext: string } {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: digestToken(token),
    tokenCiphertext: encryptShareToken(config, token)
  };
}

export function activeShareLinkForToken(db: DatabaseConnection, token: string): ActiveShareLink | null {
  if (token.length < 32 || token.length > 256) return null;
  const row = db.prepare(`SELECT id, project_id, permission, created_at, token_ciphertext
    FROM project_share_links
    WHERE token_hash = ? AND permission = 'read' AND revoked_at IS NULL`).get(digestToken(token)) as ActiveShareLink | undefined;
  return row ?? null;
}

export function shareLinkPath(config: Config, token: string): string {
  return `${basePathHref(config.basePath)}share/${encodeURIComponent(token)}`;
}

export function revealShareLinkSecret(config: Config, ciphertext: string): string {
  const [version, ivText, tagText, encryptedText] = ciphertext.split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) {
    throw new Error("Invalid share link secret");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", shareLinkKey(config), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt share link secret");
  }
}

function encryptShareToken(config: Config, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", shareLinkKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function shareLinkKey(config: Config): Buffer {
  const target = path.join(config.dataDir, "share-link.key");
  if (!fs.existsSync(target)) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(target, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!fs.existsSync(target)) throw error;
    }
  }
  const key = fs.readFileSync(target);
  if (key.length !== 32) throw new Error("Invalid share link encryption key");
  return key;
}
