// Player tokens: random secret per player; only a sha256 hash is ever stored.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const newPlayerId = () => randomUUID();
export const newPlayerToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function tokenMatches(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
