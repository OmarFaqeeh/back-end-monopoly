// Valid character ids (one shared list; the front mirrors it in public/characters/characters.json).
export const CHARACTER_IDS = ["c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08", "c09", "c10", "c11", "c12"] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];

export const isCharacterId = (value: unknown): value is CharacterId =>
  typeof value === "string" && (CHARACTER_IDS as readonly string[]).includes(value);
