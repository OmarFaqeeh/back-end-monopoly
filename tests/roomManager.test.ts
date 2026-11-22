import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIMINGS } from "../src/config/defaults.js";
import { RoomError, RoomManager } from "../src/rooms/roomManager.js";
import { InMemoryRoomRepository } from "../src/services/roomRepository.js";

let repo: InMemoryRoomRepository;
let manager: RoomManager;
const closed: { code: string; reason: string }[] = [];
const states: { code: string }[] = [];

function make(random?: (max: number) => number) {
  repo = new InMemoryRoomRepository();
  manager = new RoomManager({ repo, random, logger: { error: () => {} } });
  manager.events = {
    state: (s) => states.push({ code: s.code }),
    closed: (code, reason) => closed.push({ code, reason }),
    chat: () => {},
  };
}

const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof RoomError ? e.code : String(e);
  }
  return "NO_ERROR";
};

/** Creates a room with a connected host. */
async function hostedRoom() {
  const created = await manager.createRoom("Omar");
  const host = await manager.join({ code: created.code, nickname: "Omar", playerId: created.playerId, playerToken: created.playerToken, socketId: "s-host" });
  return { ...created, host, hostSocket: "s-host" };
}

beforeEach(() => {
  vi.useFakeTimers();
  closed.length = 0;
  states.length = 0;
  make();
});

afterEach(() => {
  manager.dispose();
  vi.useRealTimers();
});

describe("room creation", () => {
  it("issues a 6-digit code (leading zeros allowed) and the timer deadline", async () => {
    make(() => 5);
    const r = await manager.createRoom("Omar");
    expect(r.code).toBe("000005");
    expect(r.expiresAt - r.serverNow).toBeLessThanOrEqual(DEFAULT_TIMINGS.emptyTimeoutMs);
    expect(r.expiresAt - r.serverNow).toBeGreaterThan(DEFAULT_TIMINGS.emptyTimeoutMs - 1000);
    expect(r.playerToken.length).toBeGreaterThan(20);
  });

  it("retries when the unique index rejects a code", async () => {
    const seq = [1, 1, 1, 2];
    make(() => seq.shift() ?? 9);
    await repo.createRoom({ code: "000001", hostPlayerId: "x", settings: (await import("../src/config/settings.js")).DEFAULT_SETTINGS, expiresAt: new Date() });
    const r = await manager.createRoom("Omar");
    expect(r.code).toBe("000002");
  });

  it("rejects an invalid nickname", async () => {
    expect(await err(manager.createRoom("   "))).toBe("NICKNAME_INVALID");
    expect(await err(manager.createRoom("a".repeat(17)))).toBe("NICKNAME_INVALID");
    expect(await err(manager.createRoom("bad<name>"))).toBe("NICKNAME_INVALID");
  });

  it("accepts letters of any language, digits, spaces, underscore and hyphen", async () => {
    for (const n of ["عمر", "Zoë_1", "Ana-Maria", "山田 太郎"]) {
      make();
      expect((await manager.createRoom(n)).code).toMatch(/^\d{6}$/);
    }
  });

  it("never sends tokens or hashes in a snapshot", async () => {
    const r = await hostedRoom();
    const json = JSON.stringify(r.host.snapshot);
    expect(json).not.toContain(r.playerToken);
    expect(json).not.toMatch(/token|hash/i);
  });
});

describe("empty-room timer", () => {
  it("closes the room exactly at 120 s when nobody joined", async () => {
    const r = await manager.createRoom("Omar");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(manager.lookup(r.code)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.lookup(r.code)).toBeNull();
    expect(closed).toEqual([{ code: r.code, reason: "EXPIRED_EMPTY" }]);
    expect([...repo.rooms.values()][0]).toMatchObject({ status: "closed", closedReason: "EXPIRED_EMPTY" });
  });

  it("frees the code once closed", async () => {
    make(() => 42);
    const a = await manager.createRoom("Omar");
    await vi.advanceTimersByTimeAsync(120_000);
    const b = await manager.createRoom("Omar");
    expect(b.code).toBe(a.code);
  });

  it("is cancelled by a guest connecting before choosing a character", async () => {
    const r = await hostedRoom();
    await vi.advanceTimersByTimeAsync(60_000);
    await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" }); // no character picked
    await vi.advanceTimersByTimeAsync(600_000);
    expect(manager.lookup(r.code)).not.toBeNull();
    expect(closed).toHaveLength(0);
    expect(manager.getSnapshot(r.code)!.expiresAt).toBeNull();
  });

  it("does not restart when the guest leaves later", async () => {
    const r = await hostedRoom();
    const g = await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    await vi.advanceTimersByTimeAsync(10_000);
    await manager.leave(r.code, g.playerId);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(manager.lookup(r.code)).not.toBeNull();
    expect(closed).toHaveLength(0);
  });

  it("is not cancelled when the host itself reconnects", async () => {
    const r = await hostedRoom();
    manager.disconnect(r.code, r.playerId, "s-host");
    await manager.join({ code: r.code, nickname: "Omar", playerId: r.playerId, playerToken: r.playerToken, socketId: "s-host-2" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(closed).toEqual([{ code: r.code, reason: "EXPIRED_EMPTY" }]);
  });
});

describe("joining rules", () => {
  it("ROOM_NOT_FOUND, NICKNAME_INVALID, NICKNAME_TAKEN (case-insensitive)", async () => {
    const r = await hostedRoom();
    expect(await err(manager.join({ code: "123456", nickname: "x", socketId: "a" }))).toBe("ROOM_NOT_FOUND");
    expect(await err(manager.join({ code: r.code, nickname: "", socketId: "a" }))).toBe("NICKNAME_INVALID");
    expect(await err(manager.join({ code: r.code, nickname: "oMaR", socketId: "a" }))).toBe("NICKNAME_TAKEN");
  });

  it("ROOM_FULL counts seated and connecting players", async () => {
    const r = await hostedRoom();
    await manager.updateSettings(r.code, r.playerId, { maxPlayers: 2 });
    await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    expect(await err(manager.join({ code: r.code, nickname: "Lina", socketId: "s2" }))).toBe("ROOM_FULL");
    expect(manager.lookup(r.code)).toMatchObject({ joinable: false, reason: "ROOM_FULL", playerCount: 2, maxPlayers: 2 });
  });

  it("GAME_STARTED once the game is playing", async () => {
    const r = await hostedRoom();
    manager.setStatus(r.code, "playing");
    expect(await err(manager.join({ code: r.code, nickname: "Sara", socketId: "s1" }))).toBe("GAME_STARTED");
    expect(manager.lookup(r.code)).toMatchObject({ joinable: false, reason: "GAME_STARTED" });
  });
});

describe("characters", () => {
  it("resolves a race: the second pick gets CHARACTER_TAKEN", async () => {
    const r = await hostedRoom();
    const a = await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    const b = await manager.join({ code: r.code, nickname: "Lina", socketId: "s2" });
    const results = await Promise.all([
      err(manager.selectCharacter(r.code, a.playerId, "c05")),
      err(manager.selectCharacter(r.code, b.playerId, "c05")),
    ]);
    expect(results).toEqual(["NO_ERROR", "CHARACTER_TAKEN"]);
    expect(manager.getSnapshot(r.code)!.players.filter((p) => p.characterId === "c05")).toHaveLength(1);
  });

  it("rejects unknown character ids and lets a player change their pick", async () => {
    const r = await hostedRoom();
    expect(await err(manager.selectCharacter(r.code, r.playerId, "c99"))).toBe("INVALID_CHARACTER");
    await manager.selectCharacter(r.code, r.playerId, "c01");
    await manager.selectCharacter(r.code, r.playerId, "c02");
    const g = await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    await manager.selectCharacter(r.code, g.playerId, "c01"); // c01 was freed
  });
});

describe("settings", () => {
  it("only the host can change settings", async () => {
    const r = await hostedRoom();
    const g = await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    expect(await err(manager.updateSettings(r.code, g.playerId, { auctions: false }))).toBe("NOT_HOST");
    const snap = await manager.updateSettings(r.code, r.playerId, { auctions: false, startingCash: 2000 });
    expect(snap.settings).toMatchObject({ auctions: false, startingCash: 2000 });
  });

  it("validates values and cannot lower maxPlayers below the seated count", async () => {
    const r = await hostedRoom();
    await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    await manager.join({ code: r.code, nickname: "Lina", socketId: "s2" });
    expect(await err(manager.updateSettings(r.code, r.playerId, { maxPlayers: 2 }))).toBe("MAX_PLAYERS_TOO_LOW");
    expect(await err(manager.updateSettings(r.code, r.playerId, { maxPlayers: 9 }))).toBe("INVALID_SETTINGS");
    expect(await err(manager.updateSettings(r.code, r.playerId, { startingCash: 1234 }))).toBe("INVALID_SETTINGS");
    expect(await err(manager.updateSettings(r.code, r.playerId, { nope: true }))).toBe("INVALID_SETTINGS");
    expect(await err(manager.updateSettings(r.code, r.playerId, {}))).toBe("INVALID_SETTINGS");
    expect((await manager.updateSettings(r.code, r.playerId, { maxPlayers: 3 })).settings.maxPlayers).toBe(3);
  });
});

describe("leaving, grace and host transfer", () => {
  it("keeps a guest's seat for 15 s and frees it after", async () => {
    const r = await hostedRoom();
    const g = await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    manager.disconnect(r.code, g.playerId, "s1");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(manager.getSnapshot(r.code)!.players).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.getSnapshot(r.code)!.players).toHaveLength(1);
  });

  it("reconnecting with the right token keeps the seat; a wrong token is rejected", async () => {
    const r = await hostedRoom();
    const g = await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    await manager.selectCharacter(r.code, g.playerId, "c03");
    manager.disconnect(r.code, g.playerId, "s1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await err(manager.join({ code: r.code, nickname: "Sara", playerId: g.playerId, playerToken: "wrong-token-value", socketId: "s2" }))).toBe("INVALID_CREDENTIALS");
    const back = await manager.join({ code: r.code, nickname: "Sara", playerId: g.playerId, playerToken: g.playerToken, socketId: "s2" });
    expect(back.playerId).toBe(g.playerId);
    expect(back.playerToken).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    const me = manager.getSnapshot(r.code)!.players.find((p) => p.playerId === g.playerId)!;
    expect(me).toMatchObject({ connected: true, characterId: "c03" });
  });

  it("ignores a disconnect from a stale socket", async () => {
    const r = await hostedRoom();
    const g = await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    await manager.join({ code: r.code, nickname: "Sara", playerId: g.playerId, playerToken: g.playerToken, socketId: "s2" });
    manager.disconnect(r.code, g.playerId, "s1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getSnapshot(r.code)!.players.find((p) => p.playerId === g.playerId)).toBeDefined();
  });

  it("transfers the host to the earliest remaining player after the 60 s grace", async () => {
    const r = await hostedRoom();
    const first = await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    vi.setSystemTime(Date.now() + 5_000);
    await manager.join({ code: r.code, nickname: "Lina", socketId: "s2" });
    manager.disconnect(r.code, r.playerId, "s-host");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(manager.getSnapshot(r.code)!.hostPlayerId).toBe(r.playerId);
    await vi.advanceTimersByTimeAsync(1);
    const snap = manager.getSnapshot(r.code)!;
    expect(snap.hostPlayerId).toBe(first.playerId);
    expect(snap.players.find((p) => p.playerId === first.playerId)!.isHost).toBe(true);
    expect(snap.players.some((p) => p.playerId === r.playerId)).toBe(false);
  });

  it("closes with ALL_LEFT when nobody remains", async () => {
    const r = await hostedRoom();
    manager.disconnect(r.code, r.playerId, "s-host");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.lookup(r.code)).toBeNull();
    expect(closed).toEqual([{ code: r.code, reason: "ALL_LEFT" }]);
  });

  it("an explicit host leave transfers the role immediately", async () => {
    const r = await hostedRoom();
    const g = await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    await manager.leave(r.code, r.playerId);
    expect(manager.getSnapshot(r.code)!.hostPlayerId).toBe(g.playerId);
  });
});

describe("janitor", () => {
  it("closes a room with zero connected players after 60 s", async () => {
    const r = await hostedRoom();
    await manager.join({ code: r.code, nickname: "Sara", socketId: "s1" });
    manager.disconnect(r.code, r.playerId, "s-host");
    manager.disconnect(r.code, manager.getSnapshot(r.code)!.players[1]!.playerId, "s1");
    vi.setSystemTime(Date.now() + 61_000);
    await manager.sweep();
    expect(closed.at(-1)).toEqual({ code: r.code, reason: "ALL_LEFT" });
  });

  it("closes an expired room that never had a guest", async () => {
    const r = await manager.createRoom("Omar");
    vi.setSystemTime(Date.now() + 121_000);
    await manager.sweep();
    expect(closed).toEqual([{ code: r.code, reason: "EXPIRED_EMPTY" }]);
  });
});
