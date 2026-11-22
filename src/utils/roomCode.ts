// Room code: 6 digits (0 to 9, leading zeros allowed), generated with crypto.randomInt.
import { randomInt } from "node:crypto";

export const ROOM_CODE_PATTERN = /^[0-9]{6}$/;

export const isRoomCode = (value: unknown): value is string => typeof value === "string" && ROOM_CODE_PATTERN.test(value);

export function generateRoomCode(random: (max: number) => number = (max) => randomInt(max)): string {
  return String(random(1_000_000)).padStart(6, "0");
}
