import { describe, expect, it } from "vitest";
import { loadEnv, EnvError } from "../src/config/env.js";
import { generateRoomCode, isRoomCode } from "../src/utils/roomCode.js";
import { nicknameKey, validateNickname } from "../src/utils/nickname.js";
import { hashToken, newPlayerToken, tokenMatches } from "../src/utils/token.js";

describe("roomCode", () => {
  it("is always 6 digits with leading zeros", () => {
    expect(generateRoomCode(() => 0)).toBe("000000");
    expect(generateRoomCode(() => 7)).toBe("000007");
    expect(generateRoomCode(() => 999_999)).toBe("999999");
    for (let i = 0; i < 200; i++) expect(isRoomCode(generateRoomCode())).toBe(true);
  });
  it("rejects malformed codes", () => {
    for (const bad of ["12345", "1234567", "12a456", "", "١٢٣٤٥٦"]) expect(isRoomCode(bad)).toBe(false);
  });
});

describe("nickname", () => {
  it("trims and enforces 1 to 16 characters and the allowed charset", () => {
    expect(validateNickname("  Omar  ")).toBe("Omar");
    expect(validateNickname("a".repeat(16))).toBe("a".repeat(16));
    expect(validateNickname("a".repeat(17))).toBeNull();
    expect(validateNickname("")).toBeNull();
    expect(validateNickname("a<b")).toBeNull();
    expect(validateNickname("😀")).toBeNull();
    expect(validateNickname(42)).toBeNull();
  });
  it("compares case-insensitively", () => {
    expect(nicknameKey("OMAR")).toBe(nicknameKey("omar"));
  });
});

describe("tokens", () => {
  it("stores only a hash and verifies in constant time", () => {
    const t = newPlayerToken();
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(tokenMatches(t, h)).toBe(true);
    expect(tokenMatches(t + "x", h)).toBe(false);
  });
});

describe("env", () => {
  const good = { FRONT_ORIGIN: "http://localhost:3000/", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40) };
  it("parses a valid environment with defaults", () => {
    const env = loadEnv(good);
    expect(env.port).toBe(4000);
    expect(env.frontOrigin).toBe("http://localhost:3000");
    expect(env.timings.emptyTimeoutMs).toBe(120_000);
    expect(loadEnv({ ...good, ROOM_EMPTY_TIMEOUT_MS: "5000" }).timings.emptyTimeoutMs).toBe(5000);
  });
  it("allows several front-end origins and always the deployed site; FRONT_ORIGIN is optional", () => {
    const env = loadEnv({ ...good, FRONT_ORIGIN: "http://localhost:3000, https://my.site/" });
    expect(env.frontOrigins).toEqual(["http://localhost:3000", "https://my.site", "https://dealrush-kappa.vercel.app"]);
    const rest = { SUPABASE_URL: good.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: good.SUPABASE_SERVICE_ROLE_KEY };
    expect(loadEnv(rest).frontOrigins).toContain("https://dealrush-kappa.vercel.app");
    expect(() => loadEnv({ ...good, FRONT_ORIGIN: "not a url" })).toThrow(/FRONT_ORIGIN/);
  });
  it("fails fast with a clear message", () => {
    expect(() => loadEnv({})).toThrow(EnvError);
    expect(() => loadEnv({ ...good, SUPABASE_URL: "nope" })).toThrow(/SUPABASE_URL/);
  });
});
