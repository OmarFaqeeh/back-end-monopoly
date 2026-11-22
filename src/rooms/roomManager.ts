// Authoritative in-memory room state: players, host, timers. Persistence is write-through (see RoomRepository).
// Single backend instance only: rooms and timers live in this process (see README for the scaling path).
import { isCharacterId } from "../config/characters.js";
import { DEFAULT_TIMINGS, MAX_CODE_ATTEMPTS, type RoomTimings } from "../config/defaults.js";
import { DEFAULT_SETTINGS, roomSettingsSchema, settingsPatchSchema, type RoomSettings } from "../config/settings.js";
import {
  CharacterTakenError,
  CodeTakenError,
  type ClosedReason,
  type RoomRepository,
  type RoomStatus,
} from "../services/roomRepository.js";
import { nicknameKey, validateNickname } from "../utils/nickname.js";
import { generateRoomCode } from "../utils/roomCode.js";
import { hashToken, newPlayerId, newPlayerToken, tokenMatches } from "../utils/token.js";

export type RoomErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "GAME_STARTED"
  | "NICKNAME_INVALID"
  | "NICKNAME_TAKEN"
  | "CHARACTER_TAKEN"
  | "INVALID_CHARACTER"
  | "NOT_HOST"
  | "INVALID_SETTINGS"
  | "MAX_PLAYERS_TOO_LOW"
  | "INVALID_CREDENTIALS"
  | "NOT_IN_ROOM"
  | "NOT_ALLOWED_IN_GAME"
  | "MESSAGE_INVALID"
  | "RATE_LIMITED"
  | "CODE_GENERATION_FAILED";

export class RoomError extends Error {
  constructor(readonly code: RoomErrorCode) {
    super(code);
  }
}

export interface PlayerView {
  playerId: string;
  nickname: string;
  characterId: string | null;
  isHost: boolean;
  connected: boolean;
  isBot?: boolean;
}

/** What clients receive: never contains tokens or hashes. */
export interface RoomSnapshot {
  code: string;
  status: RoomStatus;
  hostPlayerId: string;
  settings: RoomSettings;
  players: PlayerView[];
  /** Deadline of the empty-room timer (ms since epoch), or null once someone else joined. */
  expiresAt: number | null;
  serverNow: number;
  /** When the next bot will join an empty seat (ms since epoch), or null. */
  botRefillAt: number | null;
}

/** A chat message as clients receive it. Chat lives in memory only (last CHAT_HISTORY per room). */
export interface ChatMessage {
  id: string;
  playerId: string;
  nickname: string;
  characterId: string | null;
  text: string;
  /** Server time, ms since epoch. */
  at: number;
  /** A system line (bots joining or leaving): the front builds the text from the code. */
  system?: { code: string; params: Record<string, string | number> };
}

export const CHAT_MAX_LENGTH = 200;
export const CHAT_HISTORY = 100;
const CHAT_BURST = 6;
const CHAT_WINDOW_MS = 10_000;

/** Callbacks for the game layer (see game/gameManager.ts). All optional. */
export interface RoomHooks {
  /** A player's socket dropped (the seat is kept for the grace period). */
  playerDisconnected?(code: string, playerId: string): void;
  /** A player came back with their credentials. */
  playerReconnected?(code: string, playerId: string): void;
  /** A player's seat was freed (explicit leave or grace expired). */
  playerRemoved?(code: string, playerId: string, reason?: "left" | "inactive"): void;
  /** The room was closed and forgotten. */
  roomClosed?(code: string): void;
  /** The host changed the settings. */
  settingsChanged?(code: string): void;
  /** A HUMAN took a seat. */
  playerJoined?(code: string, playerId: string): void;
  /** The game started. */
  gameStarted?(code: string): void;
}

export interface RoomEvents {
  state(snapshot: RoomSnapshot): void;
  closed(code: string, reason: ClosedReason): void;
  chat(code: string, message: ChatMessage): void;
}

interface PlayerState {
  playerId: string;
  tokenHash: string;
  nickname: string;
  characterId: string | null;
  isHost: boolean;
  connected: boolean;
  socketId: string | null;
  joinedAt: number;
  seq: number;
  graceTimer: ReturnType<typeof setTimeout> | null;
  chatStamps: number[];
  isBot: boolean;
  personality: string | null;
}

interface RoomState {
  id: string;
  code: string;
  status: RoomStatus;
  settings: RoomSettings;
  hostPlayerId: string;
  players: Map<string, PlayerState>;
  expiresAt: number | null;
  /** Set by the BotManager: when the next bot is due. */
  botRefillAt: number | null;
  firstGuestJoined: boolean;
  emptyTimer: ReturnType<typeof setTimeout> | null;
  zeroConnectedSince: number | null;
  messages: ChatMessage[];
  /** The game ended: the room stays in memory until everyone leaves, but is already closed in the database. */
  finished: boolean;
}

export interface RoomManagerOptions {
  repo: RoomRepository;
  timings?: RoomTimings;
  now?: () => number;
  random?: (max: number) => number;
  logger?: Pick<Console, "error">;
}

export interface JoinInput {
  code: string;
  nickname: string;
  playerId?: string;
  playerToken?: string;
  socketId: string;
}

export interface JoinResult {
  playerId: string;
  /** Only for a brand-new player. */
  playerToken?: string;
  snapshot: RoomSnapshot;
}

export class RoomManager {
  events: RoomEvents = { state: () => {}, closed: () => {}, chat: () => {} };
  private readonly hookList: RoomHooks[] = [];
  /** Dispatches to every registered listener (the game layer and the bot manager both listen). */
  readonly hooks: Required<RoomHooks> = {
    playerDisconnected: (c, p) => this.hookList.forEach((h) => h.playerDisconnected?.(c, p)),
    playerReconnected: (c, p) => this.hookList.forEach((h) => h.playerReconnected?.(c, p)),
    playerRemoved: (c, p, r) => this.hookList.forEach((h) => h.playerRemoved?.(c, p, r)),
    roomClosed: (c) => this.hookList.forEach((h) => h.roomClosed?.(c)),
    settingsChanged: (c) => this.hookList.forEach((h) => h.settingsChanged?.(c)),
    playerJoined: (c, p) => this.hookList.forEach((h) => h.playerJoined?.(c, p)),
    gameStarted: (c) => this.hookList.forEach((h) => h.gameStarted?.(c)),
  };

  addHooks(h: RoomHooks): void {
    this.hookList.push(h);
  }
  private readonly rooms = new Map<string, RoomState>();
  private readonly repo: RoomRepository;
  private readonly timings: RoomTimings;
  private readonly now: () => number;
  private readonly random?: (max: number) => number;
  private readonly logger: Pick<Console, "error">;
  private seq = 0;

  constructor(opts: RoomManagerOptions) {
    this.repo = opts.repo;
    this.timings = opts.timings ?? DEFAULT_TIMINGS;
    this.now = opts.now ?? Date.now;
    this.random = opts.random;
    this.logger = opts.logger ?? console;
  }

  /* ---------------------------------------------------------------- creation and lookup */

  async createRoom(nicknameRaw: string): Promise<{ code: string; playerId: string; playerToken: string; expiresAt: number; serverNow: number }> {
    const nickname = validateNickname(nicknameRaw);
    if (!nickname) throw new RoomError("NICKNAME_INVALID");

    const playerId = newPlayerId();
    const playerToken = newPlayerToken();
    const expiresAt = this.now() + this.timings.emptyTimeoutMs;
    let record = null;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && !record; attempt++) {
      const code = generateRoomCode(this.random);
      if (this.rooms.has(code)) continue;
      try {
        record = await this.repo.createRoom({ code, hostPlayerId: playerId, settings: DEFAULT_SETTINGS, expiresAt: new Date(expiresAt) });
      } catch (e) {
        if (!(e instanceof CodeTakenError)) throw e;
      }
    }
    if (!record) throw new RoomError("CODE_GENERATION_FAILED");

    const host: PlayerState = {
      playerId,
      tokenHash: hashToken(playerToken),
      nickname,
      characterId: null,
      isHost: true,
      connected: false,
      socketId: null,
      joinedAt: this.now(),
      seq: ++this.seq,
      graceTimer: null,
      chatStamps: [],
      isBot: false,
      personality: null,
    };
    const room: RoomState = {
      id: record.id,
      code: record.code,
      status: "waiting",
      settings: { ...DEFAULT_SETTINGS },
      hostPlayerId: playerId,
      players: new Map([[playerId, host]]),
      expiresAt,
      botRefillAt: null,
      firstGuestJoined: false,
      emptyTimer: null,
      zeroConnectedSince: this.now(),
      messages: [],
      finished: false,
    };
    this.rooms.set(room.code, room);
    room.emptyTimer = setTimeout(() => void this.expireEmpty(room.code), this.timings.emptyTimeoutMs);
    await this.persist("addPlayer(host)", () => this.repo.addPlayer({ roomId: room.id, playerId, tokenHash: host.tokenHash, nickname, isHost: true }));
    return { code: room.code, playerId, playerToken, expiresAt, serverNow: this.now() };
  }

  lookup(code: string): { code: string; status: RoomStatus; playerCount: number; maxPlayers: number; joinable: boolean; reason?: RoomErrorCode } | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    const playerCount = room.players.size;
    const maxPlayers = room.settings.maxPlayers;
    let reason: RoomErrorCode | undefined;
    if (room.status === "playing") reason = "GAME_STARTED";
    else if (playerCount >= maxPlayers) reason = "ROOM_FULL";
    return { code, status: room.status, playerCount, maxPlayers, joinable: !reason, ...(reason ? { reason } : {}) };
  }

  /** Snapshot for an existing room (used by tests and handlers). */
  getSnapshot(code: string): RoomSnapshot | null {
    const room = this.rooms.get(code);
    return room ? this.snapshot(room) : null;
  }

  get activeRoomCount(): number {
    return this.rooms.size;
  }

  /* ---------------------------------------------------------------- joining and connections */

  async join(input: JoinInput): Promise<JoinResult> {
    const room = this.rooms.get(input.code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND");

    if (input.playerId !== undefined || input.playerToken !== undefined) return this.reconnect(room, input);

    if (room.status === "playing") throw new RoomError("GAME_STARTED");
    const nickname = validateNickname(input.nickname);
    if (!nickname) throw new RoomError("NICKNAME_INVALID");
    const key = nicknameKey(nickname);
    for (const p of room.players.values()) if (nicknameKey(p.nickname) === key) throw new RoomError("NICKNAME_TAKEN");
    if (room.players.size >= room.settings.maxPlayers) {
      // Human priority: the most recently added bot leaves to make room.
      const bot = [...room.players.values()].filter((p) => p.isBot).sort((a, b) => b.joinedAt - a.joinedAt || b.seq - a.seq)[0];
      if (!bot) throw new RoomError("ROOM_FULL");
      this.dropBot(room, bot, "botMadeRoom");
    }

    const playerId = newPlayerId();
    const playerToken = newPlayerToken();
    const player: PlayerState = {
      playerId,
      tokenHash: hashToken(playerToken),
      nickname,
      characterId: null,
      isHost: false,
      connected: true,
      socketId: input.socketId,
      joinedAt: this.now(),
      seq: ++this.seq,
      graceTimer: null,
      chatStamps: [],
      isBot: false,
      personality: null,
    };
    room.players.set(playerId, player);
    this.updateZeroConnected(room);

    // Any accepted join from a different player permanently cancels the empty-room timer.
    if (!room.firstGuestJoined) {
      room.firstGuestJoined = true;
      room.expiresAt = null;
      if (room.emptyTimer) clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
      await this.persist("firstGuestJoined", () => this.repo.updateRoom(room.id, { firstGuestJoinedAt: new Date(this.now()) }));
    }
    await this.persist("addPlayer", () => this.repo.addPlayer({ roomId: room.id, playerId, tokenHash: player.tokenHash, nickname, isHost: false }));
    const snapshot = this.snapshot(room);
    this.events.state(snapshot);
    this.hooks.playerJoined(room.code, playerId);
    return { playerId, playerToken, snapshot };
  }

  private reconnect(room: RoomState, input: JoinInput): JoinResult {
    const player = input.playerId ? room.players.get(input.playerId) : undefined;
    if (!player || !input.playerToken || !tokenMatches(input.playerToken, player.tokenHash)) throw new RoomError("INVALID_CREDENTIALS");
    if (player.graceTimer) clearTimeout(player.graceTimer);
    player.graceTimer = null;
    player.connected = true;
    player.socketId = input.socketId;
    this.updateZeroConnected(room);
    const snapshot = this.snapshot(room);
    this.events.state(snapshot);
    this.hooks.playerReconnected?.(room.code, player.playerId);
    return { playerId: player.playerId, snapshot };
  }

  /** A socket closed. Guests keep their seat for the guest grace, the host keeps the role for the host grace. */
  disconnect(code: string, playerId: string, socketId: string): void {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player || player.socketId !== socketId) return; // stale socket (the player reconnected elsewhere)
    player.connected = false;
    player.socketId = null;
    this.updateZeroConnected(room);
    // During a game everyone gets the longer grace so a dropped connection can come back (the AFK auto-play covers the turns).
    const grace = player.isHost || room.status === "playing" ? this.timings.hostGraceMs : this.timings.guestGraceMs;
    if (player.graceTimer) clearTimeout(player.graceTimer);
    player.graceTimer = setTimeout(() => void this.removePlayer(code, playerId, "inactive"), grace);
    this.events.state(this.snapshot(room));
    this.hooks.playerDisconnected?.(code, playerId);
  }

  /** Explicit leave: the seat is freed immediately (host role transfers immediately too). */
  async leave(code: string, playerId: string): Promise<void> {
    const room = this.rooms.get(code);
    if (!room?.players.has(playerId)) throw new RoomError("NOT_IN_ROOM");
    await this.removePlayer(code, playerId, "left");
  }

  private async removePlayer(code: string, playerId: string, reason: "left" | "inactive" = "left"): Promise<void> {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player) return;
    if (player.graceTimer) clearTimeout(player.graceTimer);
    room.players.delete(playerId);
    this.hooks.playerRemoved?.(code, playerId, reason);
    void this.persist("player left", () => this.repo.updatePlayer(room.id, playerId, { leftAt: new Date(this.now()) }));

    if (![...room.players.values()].some((p) => !p.isBot)) {
      await this.closeRoom(room, "ALL_LEFT"); // bots alone never keep a room alive
      return;
    }
    if (player.isHost) {
      const next = [...room.players.values()].filter((p) => !p.isBot).sort((a, b) => a.joinedAt - b.joinedAt || a.seq - b.seq)[0]!;
      next.isHost = true;
      room.hostPlayerId = next.playerId;
      void this.persist("host transfer", async () => {
        await this.repo.updatePlayer(room.id, playerId, { isHost: false });
        await this.repo.updatePlayer(room.id, next.playerId, { isHost: true });
        await this.repo.updateRoom(room.id, { hostPlayerId: next.playerId });
      });
    }
    this.updateZeroConnected(room);
    this.events.state(this.snapshot(room));
  }

  /* ---------------------------------------------------------------- lobby actions */

  async selectCharacter(code: string, playerId: string, characterId: unknown): Promise<RoomSnapshot> {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player) throw new RoomError("NOT_IN_ROOM");
    if (room.status === "playing") throw new RoomError("GAME_STARTED");
    if (!isCharacterId(characterId)) throw new RoomError("INVALID_CHARACTER");
    for (const p of room.players.values()) if (p !== player && p.characterId === characterId) throw new RoomError("CHARACTER_TAKEN");

    const previous = player.characterId;
    player.characterId = characterId; // synchronous: the first pick wins any race
    try {
      await this.repo.updatePlayer(room.id, playerId, { characterId });
    } catch (e) {
      player.characterId = previous;
      if (e instanceof CharacterTakenError) throw new RoomError("CHARACTER_TAKEN");
      this.logger.error(`[persist] character failed: ${(e as Error).message}`);
      player.characterId = characterId; // memory stays authoritative
    }
    const snapshot = this.snapshot(room);
    this.events.state(snapshot);
    return snapshot;
  }

  async updateSettings(code: string, playerId: string, patchRaw: unknown): Promise<RoomSnapshot> {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player) throw new RoomError("NOT_IN_ROOM");
    if (!player.isHost) throw new RoomError("NOT_HOST");
    if (room.status === "playing") throw new RoomError("NOT_ALLOWED_IN_GAME");
    const patch = settingsPatchSchema.safeParse(patchRaw);
    if (!patch.success) throw new RoomError("INVALID_SETTINGS");
    if (patch.data.maxPlayers !== undefined && patch.data.maxPlayers < room.players.size) throw new RoomError("MAX_PLAYERS_TOO_LOW");
    const merged = roomSettingsSchema.safeParse({ ...room.settings, ...patch.data });
    if (!merged.success) throw new RoomError("INVALID_SETTINGS");
    room.settings = merged.data;
    await this.persist("settings", () => this.repo.updateRoom(room.id, { settings: room.settings }));
    const snapshot = this.snapshot(room);
    this.events.state(snapshot);
    this.hooks.settingsChanged(room.code);
    return snapshot;
  }

  /* ---------------------------------------------------------------- bots (the BotManager decides when and who) */

  /** Seats, humans, bots and the names and characters already in use: what the BotManager needs to decide. */
  seatInfo(code: string): { status: RoomStatus; max: number; seated: number; humans: number; bots: number; allowBots: boolean; nicknames: string[]; characters: string[]; hostId: string } | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    const all = [...room.players.values()];
    return {
      status: room.status,
      max: room.settings.maxPlayers,
      seated: all.length,
      humans: all.filter((p) => !p.isBot).length,
      bots: all.filter((p) => p.isBot).length,
      allowBots: room.settings.allowBots,
      nicknames: all.map((p) => p.nickname),
      characters: all.flatMap((p) => (p.characterId ? [p.characterId] : [])),
      hostId: room.hostPlayerId,
    };
  }

  /** The bots of a room with their personalities (for the game layer). */
  getBots(code: string): { id: string; personality: string }[] {
    const room = this.rooms.get(code);
    return room ? [...room.players.values()].filter((p) => p.isBot).map((p) => ({ id: p.playerId, personality: p.personality ?? "balanced" })) : [];
  }

  /** Seats a bot. It never touches the empty-room timer (only a human can cancel it). */
  async addBot(code: string, bot: { nickname: string; characterId: string; personality: string }): Promise<string | null> {
    const room = this.rooms.get(code);
    if (!room || room.status !== "waiting" || room.players.size >= room.settings.maxPlayers) return null;
    const playerId = newPlayerId();
    const player: PlayerState = {
      playerId,
      tokenHash: hashToken(newPlayerToken()),
      nickname: bot.nickname,
      characterId: bot.characterId,
      isHost: false,
      connected: true,
      socketId: null,
      joinedAt: this.now(),
      seq: ++this.seq,
      graceTimer: null,
      chatStamps: [],
      isBot: true,
      personality: bot.personality,
    };
    room.players.set(playerId, player);
    this.systemChat(room, "botJoined", { name: bot.nickname });
    this.events.state(this.snapshot(room));
    await this.persist("addBot", async () => {
      await this.repo.addPlayer({ roomId: room.id, playerId, tokenHash: player.tokenHash, nickname: bot.nickname, isHost: false, isBot: true, botPersonality: bot.personality });
      await this.repo.updatePlayer(room.id, playerId, { characterId: bot.characterId });
    });
    return playerId;
  }

  /** The host removes a bot (only before the game starts). Returns false when the request is not allowed. */
  removeBot(code: string, hostId: string, botId: string): boolean {
    const room = this.rooms.get(code);
    if (!room || room.status !== "waiting" || room.hostPlayerId !== hostId) return false;
    const bot = room.players.get(botId);
    if (!bot?.isBot) return false;
    this.dropBot(room, bot, "botLeft");
    return true;
  }

  /** Removes every bot at once (Allow bots turned OFF). */
  removeAllBots(code: string): number {
    const room = this.rooms.get(code);
    if (!room || room.status !== "waiting") return 0;
    const bots = [...room.players.values()].filter((p) => p.isBot);
    for (const bot of bots) this.dropBot(room, bot, "botLeft", false);
    if (bots.length) this.events.state(this.snapshot(room));
    return bots.length;
  }

  setBotRefillAt(code: string, at: number | null): void {
    const room = this.rooms.get(code);
    if (!room || room.botRefillAt === at) return;
    room.botRefillAt = at;
    this.events.state(this.snapshot(room));
  }

  private dropBot(room: RoomState, bot: PlayerState, reason: "botLeft" | "botMadeRoom", announce = true): void {
    room.players.delete(bot.playerId);
    void this.persist("bot left", () => this.repo.updatePlayer(room.id, bot.playerId, { leftAt: new Date(this.now()) }));
    this.systemChat(room, reason, { name: bot.nickname });
    if (announce) this.events.state(this.snapshot(room));
  }

  private systemChat(room: RoomState, code: string, params: Record<string, string | number>): void {
    const message: ChatMessage = { id: newPlayerId(), playerId: "system", nickname: "", characterId: null, text: "", at: this.now(), system: { code, params } };
    room.messages.push(message);
    if (room.messages.length > CHAT_HISTORY) room.messages.splice(0, room.messages.length - CHAT_HISTORY);
    this.events.chat(room.code, message);
  }

  /* ---------------------------------------------------------------- chat */

  /** Recent messages, sent to a player right after joining so late joiners see the conversation. */
  getMessages(code: string): ChatMessage[] {
    return [...(this.rooms.get(code)?.messages ?? [])];
  }

  /** Validates, stores (in memory) and broadcasts one message. Returns it for the sender's ack. */
  sendChat(code: string, playerId: string, textRaw: unknown): ChatMessage {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player) throw new RoomError("NOT_IN_ROOM");
    if (typeof textRaw !== "string") throw new RoomError("MESSAGE_INVALID");
    // eslint-disable-next-line no-control-regex
    const text = textRaw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!text || [...text].length > CHAT_MAX_LENGTH) throw new RoomError("MESSAGE_INVALID");

    const now = this.now();
    while (player.chatStamps.length && now - player.chatStamps[0]! > CHAT_WINDOW_MS) player.chatStamps.shift();
    if (player.chatStamps.length >= CHAT_BURST) throw new RoomError("RATE_LIMITED");
    player.chatStamps.push(now);

    const message: ChatMessage = { id: newPlayerId(), playerId, nickname: player.nickname, characterId: player.characterId, text, at: now };
    room.messages.push(message);
    if (room.messages.length > CHAT_HISTORY) room.messages.splice(0, room.messages.length - CHAT_HISTORY);
    this.events.chat(code, message);
    return message;
  }

  /* ---------------------------------------------------------------- closing, timers, janitor */

  private async expireEmpty(code: string): Promise<void> {
    const room = this.rooms.get(code);
    if (!room || room.firstGuestJoined || room.status !== "waiting") return;
    await this.closeRoom(room, "EXPIRED_EMPTY");
  }

  async closeByCode(code: string, reason: ClosedReason): Promise<void> {
    const room = this.rooms.get(code);
    if (room) await this.closeRoom(room, reason);
  }

  private async closeRoom(room: RoomState, reason: ClosedReason): Promise<void> {
    if (!this.rooms.delete(room.code)) return;
    room.status = "closed";
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
    for (const p of room.players.values()) if (p.graceTimer) clearTimeout(p.graceTimer);
    this.events.closed(room.code, reason);
    this.hooks.roomClosed?.(room.code);
    // A finished game was already closed in the database with GAME_OVER: do not overwrite that reason.
    if (!room.finished) await this.persist("closeRoom", () => this.repo.closeRoom(room.id, reason));
  }

  /** Janitor (call every 30 s): backup for the exact timers. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (!room.firstGuestJoined && room.expiresAt !== null && now >= room.expiresAt) await this.closeRoom(room, "EXPIRED_EMPTY");
      else if (room.zeroConnectedSince !== null && now - room.zeroConnectedSince > this.timings.zeroConnectedCloseMs) {
        await this.closeRoom(room, "ALL_LEFT");
      }
    }
  }

  /** Status change hook for the future game engine (start) and for tests. */
  setStatus(code: string, status: RoomStatus): void {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND");
    room.status = status;
    void this.persist("status", () => this.repo.updateRoom(room.id, { status }));
    this.events.state(this.snapshot(room));
  }

  /** The host started the game: the room becomes "playing" (settings are frozen, new joins get GAME_STARTED). */
  markGameStarted(code: string): void {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND");
    room.status = "playing";
    void this.persist("status", () => this.repo.updateRoom(room.id, { status: "playing" }));
    void this.persist("gameStartedAt", () => this.repo.updateRoom(room.id, { gameStartedAt: new Date(this.now()) }));
    this.events.state(this.snapshot(room));
    this.hooks.gameStarted(code);
  }

  /** The game is over: close the room in the database (GAME_OVER) but keep it in memory until everyone leaves. */
  markGameFinished(code: string, winnerPlayerId: string): void {
    const room = this.rooms.get(code);
    if (!room || room.finished) return;
    room.finished = true;
    void this.persist("finishGame", () => this.repo.finishGame(room.id, winnerPlayerId, new Date(this.now())));
  }

  /** Clears every timer (tests and shutdown). */
  dispose(): void {
    for (const room of this.rooms.values()) {
      if (room.emptyTimer) clearTimeout(room.emptyTimer);
      for (const p of room.players.values()) if (p.graceTimer) clearTimeout(p.graceTimer);
    }
    this.rooms.clear();
  }

  /* ---------------------------------------------------------------- helpers */

  private updateZeroConnected(room: RoomState): void {
    const anyConnected = [...room.players.values()].some((p) => p.connected && !p.isBot); // only humans keep a room alive
    if (anyConnected) room.zeroConnectedSince = null;
    else if (room.zeroConnectedSince === null) room.zeroConnectedSince = this.now();
  }

  private snapshot(room: RoomState): RoomSnapshot {
    const players = [...room.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt || a.seq - b.seq)
      .map((p) => ({ playerId: p.playerId, nickname: p.nickname, characterId: p.characterId, isHost: p.isHost, connected: p.connected, ...(p.isBot ? { isBot: true } : {}) }));
    return {
      code: room.code,
      status: room.status,
      hostPlayerId: room.hostPlayerId,
      settings: { ...room.settings },
      players,
      expiresAt: room.firstGuestJoined ? null : room.expiresAt,
      serverNow: this.now(),
      botRefillAt: room.botRefillAt,
    };
  }

  private async persist(action: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.error(`[persist] ${action} failed: ${(e as Error).message}`);
    }
  }
}
