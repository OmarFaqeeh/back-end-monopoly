// Persistence interface for rooms and players, with an in-memory implementation (tests) next to the
// Supabase one (supabaseRoomRepository.ts). The RoomManager stays authoritative; the repository is write-through.
import type { RoomSettings } from "../config/settings.js";

export type RoomStatus = "waiting" | "playing" | "closed";
export type ClosedReason = "EXPIRED_EMPTY" | "ALL_LEFT" | "SERVER_RESTART" | "GAME_OVER";

export interface RoomRecord {
  id: string;
  code: string;
  status: RoomStatus;
  hostPlayerId: string | null;
  settings: RoomSettings;
  createdAt: Date;
  expiresAt: Date;
  firstGuestJoinedAt: Date | null;
  closedAt: Date | null;
  closedReason: ClosedReason | null;
  gameStartedAt: Date | null;
  finishedAt: Date | null;
  winnerPlayerId: string | null;
}

export interface PlayerRecord {
  id: string;
  roomId: string;
  playerId: string;
  tokenHash: string;
  nickname: string;
  characterId: string | null;
  isHost: boolean;
  joinedAt: Date;
  leftAt: Date | null;
  isBot: boolean;
  botPersonality: string | null;
}

export class CodeTakenError extends Error {
  constructor() {
    super("ROOM_CODE_TAKEN");
  }
}

export class CharacterTakenError extends Error {
  constructor() {
    super("CHARACTER_TAKEN");
  }
}

export interface NewRoom {
  code: string;
  hostPlayerId: string;
  settings: RoomSettings;
  expiresAt: Date;
}

export interface NewPlayer {
  roomId: string;
  playerId: string;
  tokenHash: string;
  nickname: string;
  isHost: boolean;
  /** Computer players (migration 0003). */
  isBot?: boolean;
  botPersonality?: string;
}

export interface RoomPatch {
  status?: RoomStatus;
  hostPlayerId?: string | null;
  settings?: RoomSettings;
  firstGuestJoinedAt?: Date;
  gameStartedAt?: Date;
}

export interface PlayerPatch {
  characterId?: string | null;
  isHost?: boolean;
  leftAt?: Date | null;
}

export interface RoomRepository {
  /** Throws CodeTakenError when an active room already uses the code (unique index). */
  createRoom(input: NewRoom): Promise<RoomRecord>;
  getActiveByCode(code: string): Promise<RoomRecord | null>;
  updateRoom(roomId: string, patch: RoomPatch): Promise<void>;
  addPlayer(input: NewPlayer): Promise<PlayerRecord>;
  /** Throws CharacterTakenError when another active player in the room has the character (unique index). */
  updatePlayer(roomId: string, playerId: string, patch: PlayerPatch): Promise<void>;
  closeRoom(roomId: string, reason: ClosedReason): Promise<void>;
  /** Game over: closes the room with GAME_OVER and records the winner and the finish time (migration 0002). */
  finishGame(roomId: string, winnerPlayerId: string, finishedAt: Date): Promise<void>;
  /** Closes every non-closed room; returns how many were closed. */
  closeAllActive(reason: ClosedReason): Promise<number>;
  /** Removes a room and its players (tests and the Supabase self-check only). */
  deleteRoom(roomId: string): Promise<void>;
}

export class InMemoryRoomRepository implements RoomRepository {
  readonly rooms = new Map<string, RoomRecord>();
  readonly players = new Map<string, PlayerRecord>();
  private seq = 0;

  async createRoom(input: NewRoom): Promise<RoomRecord> {
    for (const r of this.rooms.values()) if (r.code === input.code && r.status !== "closed") throw new CodeTakenError();
    const record: RoomRecord = {
      id: `room-${++this.seq}`,
      code: input.code,
      status: "waiting",
      hostPlayerId: input.hostPlayerId,
      settings: input.settings,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      firstGuestJoinedAt: null,
      closedAt: null,
      closedReason: null,
      gameStartedAt: null,
      finishedAt: null,
      winnerPlayerId: null,
    };
    this.rooms.set(record.id, record);
    return structuredClone(record);
  }

  async getActiveByCode(code: string): Promise<RoomRecord | null> {
    for (const r of this.rooms.values()) if (r.code === code && r.status !== "closed") return structuredClone(r);
    return null;
  }

  async updateRoom(roomId: string, patch: RoomPatch): Promise<void> {
    const r = this.rooms.get(roomId);
    if (r) Object.assign(r, patch);
  }

  async addPlayer(input: NewPlayer): Promise<PlayerRecord> {
    const record: PlayerRecord = { id: `pl-${++this.seq}`, ...input, isBot: input.isBot ?? false, botPersonality: input.botPersonality ?? null, characterId: null, joinedAt: new Date(), leftAt: null };
    this.players.set(`${input.roomId}:${input.playerId}`, record);
    return structuredClone(record);
  }

  async updatePlayer(roomId: string, playerId: string, patch: PlayerPatch): Promise<void> {
    const p = this.players.get(`${roomId}:${playerId}`);
    if (!p) return;
    if (patch.characterId) {
      for (const o of this.players.values()) {
        if (o !== p && o.roomId === roomId && o.leftAt === null && o.characterId === patch.characterId) throw new CharacterTakenError();
      }
    }
    Object.assign(p, patch);
  }

  async closeRoom(roomId: string, reason: ClosedReason): Promise<void> {
    const r = this.rooms.get(roomId);
    if (r) Object.assign(r, { status: "closed", closedAt: new Date(), closedReason: reason });
  }

  async finishGame(roomId: string, winnerPlayerId: string, finishedAt: Date): Promise<void> {
    const r = this.rooms.get(roomId);
    if (r) Object.assign(r, { status: "closed", closedAt: finishedAt, closedReason: "GAME_OVER", finishedAt, winnerPlayerId });
  }

  async closeAllActive(reason: ClosedReason): Promise<number> {
    let n = 0;
    for (const r of this.rooms.values()) {
      if (r.status !== "closed") {
        Object.assign(r, { status: "closed", closedAt: new Date(), closedReason: reason });
        n++;
      }
    }
    return n;
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
    for (const key of [...this.players.keys()]) if (key.startsWith(`${roomId}:`)) this.players.delete(key);
  }
}
