import http from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { Server } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { CHAT_HISTORY, RoomError, RoomManager, type ChatMessage } from "../src/rooms/roomManager.js";
import { InMemoryRoomRepository } from "../src/services/roomRepository.js";
import { registerRoomHandlers } from "../src/sockets/roomHandlers.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RoomError ? e.code : String(e);
  }
  return "NO_ERROR";
};

describe("chat rules (RoomManager)", () => {
  let manager: RoomManager;
  let now = 1_000_000;
  const sent: ChatMessage[] = [];

  async function setup() {
    manager = new RoomManager({ repo: new InMemoryRoomRepository(), now: () => now, logger: { error: () => {} } });
    manager.events = { state: () => {}, closed: () => {}, chat: (_c, m) => sent.push(m) };
    sent.length = 0;
    const created = await manager.createRoom("Omar");
    await manager.join({ code: created.code, nickname: "Omar", playerId: created.playerId, playerToken: created.playerToken, socketId: "s1" });
    return created;
  }

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  it("broadcasts a cleaned message with the sender's name, character and server time", async () => {
    vi.useFakeTimers();
    const room = await setup();
    await manager.selectCharacter(room.code, room.playerId, "c03");
    const msg = manager.sendChat(room.code, room.playerId, "  hello\n\n  world \u0007 ");
    expect(msg).toMatchObject({ playerId: room.playerId, nickname: "Omar", characterId: "c03", text: "hello world", at: now });
    expect(sent).toEqual([msg]);
    expect(manager.getMessages(room.code)).toEqual([msg]);
  });

  it("rejects empty, too long and non-string messages, and strangers", async () => {
    vi.useFakeTimers();
    const room = await setup();
    expect(code(() => manager.sendChat(room.code, room.playerId, "   "))).toBe("MESSAGE_INVALID");
    expect(code(() => manager.sendChat(room.code, room.playerId, "x".repeat(201)))).toBe("MESSAGE_INVALID");
    expect(code(() => manager.sendChat(room.code, room.playerId, 42))).toBe("MESSAGE_INVALID");
    expect(code(() => manager.sendChat(room.code, "not-a-player", "hi"))).toBe("NOT_IN_ROOM");
    expect(code(() => manager.sendChat("000000", room.playerId, "hi"))).toBe("NOT_IN_ROOM");
    expect(code(() => manager.sendChat(room.code, room.playerId, "x".repeat(200)))).toBe("NO_ERROR");
  });

  it("rate limits a player and recovers after the window", async () => {
    vi.useFakeTimers();
    const room = await setup();
    for (let i = 0; i < 6; i++) manager.sendChat(room.code, room.playerId, `m${i}`);
    expect(code(() => manager.sendChat(room.code, room.playerId, "too fast"))).toBe("RATE_LIMITED");
    now += 10_001;
    expect(code(() => manager.sendChat(room.code, room.playerId, "ok again"))).toBe("NO_ERROR");
  });

  it("keeps only the latest messages", async () => {
    vi.useFakeTimers();
    const room = await setup();
    for (let i = 0; i < CHAT_HISTORY + 20; i++) {
      now += 11_000; // stay under the rate limit
      manager.sendChat(room.code, room.playerId, `m${i}`);
    }
    const history = manager.getMessages(room.code);
    expect(history).toHaveLength(CHAT_HISTORY);
    expect(history[history.length - 1]!.text).toBe(`m${CHAT_HISTORY + 19}`);
  });
});

describe("chat over sockets", () => {
  let server: http.Server;
  let io: Server;
  let mgr: RoomManager;
  const clients: Socket[] = [];

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.disconnect());
    mgr?.dispose();
    io?.close();
    await new Promise((r) => server?.close(r));
  });

  it("delivers to everyone in the room, gives history to late joiners and ignores outsiders", async () => {
    mgr = new RoomManager({ repo: new InMemoryRoomRepository(), logger: { error: () => {} } });
    server = http.createServer(createApp({ manager: mgr, frontOrigin: "http://localhost:3000" }));
    io = new Server(server, { cors: { origin: "http://localhost:3000" } });
    registerRoomHandlers(io, mgr);
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = () => {
      const s = connect(url, { transports: ["websocket"], forceNew: true });
      clients.push(s);
      return s;
    };
    const emit = <T>(s: Socket, event: string, payload: unknown) => new Promise<T>((resolve) => s.emit(event, payload, resolve));

    const res = await fetch(`${url}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nickname: "Omar" }) });
    const room = (await res.json()) as { code: string; playerId: string; playerToken: string };

    const host = client();
    await emit(host, "room:join", { code: room.code, nickname: "Omar", playerId: room.playerId, playerToken: room.playerToken });
    const guest = client();
    const guestJoin = await emit<{ ok: boolean; messages: ChatMessage[] }>(guest, "room:join", { code: room.code, nickname: "Sara" });
    expect(guestJoin.messages).toEqual([]);

    const hostGets = new Promise<ChatMessage>((r) => host.once("chat:message", r));
    const guestGets = new Promise<ChatMessage>((r) => guest.once("chat:message", r));
    const ack = await emit<{ ok: true; message: ChatMessage }>(guest, "chat:send", { text: "hello team" });
    expect(ack.ok).toBe(true);
    const [toHost, toGuest] = await Promise.all([hostGets, guestGets]);
    expect(toHost).toMatchObject({ nickname: "Sara", text: "hello team" });
    expect(toGuest.id).toBe(toHost.id);

    // A player who joins later receives the history in the join ack.
    const late = client();
    const lateJoin = await emit<{ ok: boolean; messages: ChatMessage[] }>(late, "room:join", { code: room.code, nickname: "Lina" });
    expect(lateJoin.messages.map((m) => m.text)).toEqual(["hello team"]);

    // A socket that never joined cannot chat; bad payloads are rejected.
    const outsider = client();
    expect(await emit(outsider, "chat:send", { text: "hi" })).toEqual({ ok: false, error: "NOT_IN_ROOM" });
    expect(await emit(guest, "chat:send", { text: "   " })).toEqual({ ok: false, error: "MESSAGE_INVALID" });
    expect(await emit(guest, "chat:send", { nope: 1 })).toEqual({ ok: false, error: "VALIDATION_ERROR" });
  });
});
