// Bots in the lobby (fake timers): fill counts, names and characters, removal and refill, human priority, switching
// off, maxPlayers changes, the empty-room countdown, and the end of a game when every human is out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_NAMES } from "../src/config/botNames.js";
import { DEFAULT_TIMINGS } from "../src/config/defaults.js";
import { GameManager } from "../src/game/gameManager.js";
import { BotManager } from "../src/rooms/botManager.js";
import { RoomError, RoomManager } from "../src/rooms/roomManager.js";
import { InMemoryRoomRepository } from "../src/services/roomRepository.js";
import type { GameEvent } from "../src/shared/events.js";
import { nicknameKey } from "../src/utils/nickname.js";

let manager: RoomManager;
let bots: BotManager;
let game: GameManager;
let seed = 1;
const events: GameEvent[] = [];
const chats: { code: string; text: string }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  events.length = 0;
  chats.length = 0;
  seed = 1;
  manager = new RoomManager({ repo: new InMemoryRoomRepository(), logger: { error: () => {} } });
  // a small deterministic random source
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  bots = new BotManager(manager, { random });
  game = new GameManager({ manager, testMode: true, timings: { ...DEFAULT_TIMINGS, afkStepMs: 100 }, logger: { error: () => {} } });
  game.emitter = { started: () => {}, over: () => {}, events: (_c, p) => events.push(...p.events) };
  manager.events = { state: () => {}, closed: () => {}, chat: (code, m) => chats.push({ code, text: m.system ? `${m.system.code}:${m.system.params.name ?? ""}` : m.text }) };
});
afterEach(() => {
  bots.dispose();
  game.dispose();
  manager.dispose();
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const seat = (code: string) => manager.seatInfo(code)!;
const botsOf = (code: string) => manager.getBots(code);

/** A room with `humans` humans (the host first) and the given max players, bots OFF. */
async function room(humans: number, max: number, names = ["Omar", "Sara", "Lina", "Ali"]) {
  const created = await manager.createRoom(names[0]!);
  await manager.join({ code: created.code, nickname: names[0]!, playerId: created.playerId, playerToken: created.playerToken, socketId: "s-0" });
  const ids = [created.playerId];
  for (let i = 1; i < humans; i++) ids.push((await manager.join({ code: created.code, nickname: names[i]!, socketId: `s-${i}` })).playerId);
  await manager.updateSettings(created.code, created.playerId, { maxPlayers: max });
  return { code: created.code, host: created.playerId, ids };
}
const allowBots = async (r: { code: string; host: string }, on = true) => {
  await manager.updateSettings(r.code, r.host, { allowBots: on });
  await flush();
};

describe("filling seats", () => {
  it.each([
    [1, 4, 3],
    [2, 4, 2],
    [3, 4, 1],
    [4, 4, 0],
    [1, 2, 1],
  ])("%i human(s) and max %i gives %i bot(s) in the same moment", async (humans, max, expected) => {
    const r = await room(humans, max);
    await allowBots(r);
    expect(botsOf(r.code)).toHaveLength(expected);
    expect(seat(r.code).seated).toBe(Math.max(humans, max));
  });

  it("every bot has a different name and character, no name equals a human nickname (any case), and a personality", async () => {
    for (let run = 0; run < 20; run++) {
      seed = run + 7;
      const r = await room(2, 8, ["jason", "MICHAEL"]); // humans named like bots
      await allowBots(r);
      const info = seat(r.code);
      const nicknames = info.nicknames.map(nicknameKey);
      expect(new Set(nicknames).size).toBe(nicknames.length); // all unique
      expect(info.nicknames.slice(2).every((n) => BOT_NAMES.includes(n as never))).toBe(true);
      expect(info.nicknames.slice(2).map(nicknameKey)).not.toContain("jason");
      expect(info.nicknames.slice(2).map(nicknameKey)).not.toContain("michael");
      expect(new Set(info.characters).size).toBe(info.characters.length); // every bot looks different
      expect(info.characters).toHaveLength(6);
      expect(botsOf(r.code).every((b) => ["tycoon", "careful", "spender", "collector", "balanced"].includes(b.personality))).toBe(true);
      await manager.closeByCode(r.code, "ALL_LEFT");
    }
  });

  it("personalities are random: a larger room does not give every bot the same one", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      seed = i * 13 + 1;
      const r = await room(1, 8);
      await allowBots(r);
      botsOf(r.code).forEach((b) => seen.add(b.personality));
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("a bot is never the host and cannot be removed by a guest", async () => {
    const r = await room(2, 4);
    await allowBots(r);
    for (const b of botsOf(r.code)) expect(b.id).not.toBe(seat(r.code).hostId);
    const bot = botsOf(r.code)[0]!;
    expect(bots.removeByHost(r.code, r.ids[1]!, bot.id)).toBe(false); // a guest
    expect(botsOf(r.code)).toHaveLength(2);
  });

  it("system chat lines announce bots joining and leaving", async () => {
    const r = await room(1, 2);
    await allowBots(r);
    const bot = botsOf(r.code)[0]!;
    expect(chats.filter((c) => c.text.startsWith("botJoined:"))).toHaveLength(1);
    bots.removeByHost(r.code, r.host, bot.id);
    expect(chats.some((c) => c.text.startsWith("botLeft:"))).toBe(true);
  });
});

describe("removal and refill", () => {
  it("X removes a bot; the seat is refilled after exactly 10 s", async () => {
    const r = await room(1, 3);
    await allowBots(r);
    const [first, second] = botsOf(r.code) as [{ id: string }, { id: string }];
    expect(bots.removeByHost(r.code, r.host, first.id)).toBe(true);
    expect(botsOf(r.code)).toHaveLength(1);
    expect(manager.getBots(r.code)[0]!.id).toBe(second.id);
    expect(manager.seatInfo(r.code)!.seated).toBe(2);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(botsOf(r.code)).toHaveLength(1); // not yet
    await vi.advanceTimersByTimeAsync(200);
    expect(botsOf(r.code)).toHaveLength(2); // refilled with a NEW bot
    expect(botsOf(r.code).some((b) => b.id === first.id)).toBe(false);
  });

  it("with several empty seats: 10 s for the first, then one bot every 5 s", async () => {
    const r = await room(1, 5);
    await allowBots(r);
    const ids = botsOf(r.code).map((b) => b.id);
    expect(ids).toHaveLength(4);
    for (const id of ids.slice(0, 3)) bots.removeByHost(r.code, r.host, id);
    expect(botsOf(r.code)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(botsOf(r.code)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(botsOf(r.code)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(botsOf(r.code)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(botsOf(r.code)).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(botsOf(r.code)).toHaveLength(4); // full: no more
  });

  it("the room snapshot says when the next bot joins (for the 'A bot joins in Ns' line)", async () => {
    const r = await room(1, 3);
    await allowBots(r);
    let refillAt: number | null = null;
    manager.events = { ...manager.events, state: (s) => void (refillAt = s.botRefillAt) };
    bots.removeByHost(r.code, r.host, botsOf(r.code)[0]!.id);
    expect(refillAt).toBe(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(refillAt).toBeNull();
  });

  it("a human taking the seat cancels its refill", async () => {
    const r = await room(1, 2);
    await allowBots(r);
    bots.removeByHost(r.code, r.host, botsOf(r.code)[0]!.id);
    await vi.advanceTimersByTimeAsync(5_000);
    await manager.join({ code: r.code, nickname: "Sara", socketId: "s-9" }); // a human takes the only free seat
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(botsOf(r.code)).toHaveLength(0);
    expect(seat(r.code).seated).toBe(2);
  });

  it("human priority: a human joining a full room removes the MOST RECENT bot", async () => {
    const r = await room(1, 4);
    await allowBots(r);
    const before = botsOf(r.code).map((b) => b.id);
    const info = seat(r.code);
    expect(info.seated).toBe(4);
    const joined = await manager.join({ code: r.code, nickname: "Newcomer", socketId: "s-7" });
    expect(joined.snapshot.players.some((p) => p.nickname === "Newcomer")).toBe(true);
    const after = botsOf(r.code).map((b) => b.id);
    expect(after).toHaveLength(2);
    expect(after).toEqual(before.slice(0, 2)); // the last one added is gone
    expect(chats.some((c) => c.text.startsWith("botMadeRoom:"))).toBe(true);
  });

  it("a full room of only humans still answers ROOM_FULL", async () => {
    const r = await room(4, 4);
    await expect(manager.join({ code: r.code, nickname: "Late", socketId: "s-8" })).rejects.toMatchObject({ code: "ROOM_FULL" });
    void RoomError;
  });
});

describe("settings", () => {
  it("turning Allow bots OFF removes every bot at once and stops refills; ON again fills everything again", async () => {
    const r = await room(1, 4);
    await allowBots(r);
    bots.removeByHost(r.code, r.host, botsOf(r.code)[0]!.id); // a refill is now pending
    await allowBots(r, false);
    expect(botsOf(r.code)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(botsOf(r.code)).toHaveLength(0); // nothing refilled
    await allowBots(r, true);
    expect(botsOf(r.code)).toHaveLength(3);
  });

  it("changing maxPlayers while ON fills the new seats at once and a lower number removes surplus bots (newest first); humans are never removed", async () => {
    const r = await room(1, 2);
    await allowBots(r);
    expect(seat(r.code).seated).toBe(2);
    await manager.updateSettings(r.code, r.host, { maxPlayers: 4 });
    await flush();
    expect(seat(r.code).seated).toBe(4); // filled in the same moment
    await manager.updateSettings(r.code, r.host, { maxPlayers: 3 });
    expect(seat(r.code)).toMatchObject({ seated: 3, humans: 1, bots: 2 });
    await manager.updateSettings(r.code, r.host, { maxPlayers: 2 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seat(r.code)).toMatchObject({ seated: 2, humans: 1, bots: 1 });
    // two humans and a bot: the table cannot go below the humans
    await manager.updateSettings(r.code, r.host, { maxPlayers: 3 });
    await manager.join({ code: r.code, nickname: "Sara", socketId: "s-9" });
    await expect(manager.updateSettings(r.code, r.host, { maxPlayers: 2 })).resolves.toBeDefined(); // the bot makes room
    expect(seat(r.code)).toMatchObject({ seated: 2, humans: 2, bots: 0 });
  });

  it.each([2, 3, 4, 5, 6, 7, 8])("max %i: bots ON fills every empty seat, and every other size works afterwards", async (max) => {
    const r = await room(1, max);
    await allowBots(r);
    expect(seat(r.code)).toMatchObject({ seated: max, humans: 1, bots: max - 1 });
    for (const next of [2, 8, 3, 6, 2, max]) {
      await manager.updateSettings(r.code, r.host, { maxPlayers: next });
      await flush();
      expect(seat(r.code)).toMatchObject({ seated: next, humans: 1, bots: next - 1 });
    }
  });
});

describe("the empty-room countdown and room cleanup", () => {
  it("a bot counts as a player: once one sits at the table the 2-minute countdown is cancelled and the room stays open", async () => {
    const closed: string[] = [];
    manager.events = { ...manager.events, closed: (_c, reason) => void closed.push(reason) };
    const r = await room(1, 4);
    await allowBots(r);
    expect(botsOf(r.code)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(closed).toEqual([]);
    expect(manager.lookup(r.code)).not.toBeNull();
  });

  it("a human guest cancels the countdown; so does starting the game with bots", async () => {
    const guest = await room(1, 4);
    await allowBots(guest);
    await manager.join({ code: guest.code, nickname: "Sara", socketId: "s-5" });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(manager.lookup(guest.code)).not.toBeNull();

    const solo = await room(1, 2);
    await allowBots(solo);
    await manager.selectCharacter(solo.code, solo.host, "c01");
    game.start(solo.code, solo.host); // host + 1 bot: needs 2 seated including bots
    await vi.advanceTimersByTimeAsync(130_000);
    expect(manager.lookup(solo.code)).not.toBeNull();
  });

  it("the room closes when no human remains connected for 60 s (bots do not keep it alive)", async () => {
    const closed: string[] = [];
    manager.events = { ...manager.events, closed: (_c, reason) => void closed.push(reason) };
    const r = await room(2, 4);
    await allowBots(r);
    manager.disconnect(r.code, r.ids[0]!, "s-0");
    manager.disconnect(r.code, r.ids[1]!, "s-1");
    await vi.advanceTimersByTimeAsync(61_000);
    await manager.sweep();
    expect(closed).toContain("ALL_LEFT");
  });

  it("bots alone never keep a room open when the last human leaves", async () => {
    const closed: string[] = [];
    manager.events = { ...manager.events, closed: (_c, reason) => void closed.push(reason) };
    const r = await room(1, 3);
    await allowBots(r);
    await manager.leave(r.code, r.host);
    expect(closed).toEqual(["ALL_LEFT"]);
  });
});

describe("bots in a game", () => {
  it("a game with bots starts, the bots move on their own, and nobody is a rejected action", async () => {
    const r = await room(1, 4);
    await allowBots(r);
    await manager.selectCharacter(r.code, r.host, "c01");
    game.start(r.code, r.host);
    expect(game.getSnapshot(r.code)!.players).toHaveLength(4);
    // the human drops: the AFK rule plays for them, the bots play their own turns with human-like pauses
    const bot = new Set(manager.getBots(r.code).map((b) => b.id));
    manager.disconnect(r.code, r.host, "s-0");
    await vi.advanceTimersByTimeAsync(58_000); // (the room itself closes 60 s after the last human leaves)
    expect(game.rejectedBotActions).toBe(0);
    expect(events.filter((e) => e.type === "DICE_ROLLED").length).toBeGreaterThan(3);
    expect(events.some((e) => e.type === "DICE_ROLLED" && bot.has(e.playerId))).toBe(true);
  });

  it("when every human is out (resigned), the game ends at once: the bot with the highest net worth wins", async () => {
    const r = await room(1, 3);
    await allowBots(r);
    await manager.selectCharacter(r.code, r.host, "c01");
    game.start(r.code, r.host);
    game.resign(r.code, r.host);
    const over = events.find((e) => e.type === "GAME_OVER");
    expect(over).toBeTruthy();
    const winner = (over as { winnerPlayerId: string }).winnerPlayerId;
    expect(botsOf(r.code).map((b) => b.id)).toContain(winner);
    expect(game.getSnapshot(r.code)!.phase).toBe("gameOver");
  });
});
