// Nickname rules: 1 to 16 characters after trim; letters in any language, digits, spaces, "_" and "-".
import { NICKNAME_MAX } from "../config/defaults.js";

const ALLOWED = /^[\p{L}\p{M}\p{N} _-]+$/u;

/** Returns the trimmed nickname, or null when it is invalid. */
export function validateNickname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const nickname = raw.trim();
  const length = [...nickname].length;
  if (length < 1 || length > NICKNAME_MAX) return null;
  return ALLOWED.test(nickname) ? nickname : null;
}

/** Key used to compare nicknames within a room (case-insensitive). */
export const nicknameKey = (nickname: string) => nickname.normalize("NFKC").toLocaleLowerCase();
