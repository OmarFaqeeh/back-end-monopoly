// Supabase (Postgres) implementation of RoomRepository. Uses the service role key (server only).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomSettings } from "../config/settings.js";
import {
  CharacterTakenError,
  CodeTakenError,
  type ClosedReason,
  type NewPlayer,
  type NewRoom,
  type PlayerPatch,
  type PlayerRecord,
  type RoomPatch,
  type RoomRecord,
  type RoomRepository,
  type RoomStatus,
} from "./roomRepository.js";

const UNIQUE_VIOLATION = "23505";

interface RoomRow {
  id: string;
  code: string;
  status: RoomStatus;
  host_player_id: string | null;
  settings: RoomSettings;
  created_at: string;
  expires_at: string;
  first_guest_joined_at: string | null;
  closed_at: string | null;
  closed_reason: ClosedReason | null;
  game_started_at?: string | null;
  finished_at?: string | null;
  winner_player_id?: string | null;
}

interface PlayerRow {
  id: string;
  room_id: string;
  player_id: string;
  token_hash: string;
  nickname: string;
  character_id: string | null;
  is_host: boolean;
  joined_at: string;
  left_at: string | null;
  is_bot?: boolean;
  bot_personality?: string | null;
}

const date = (v: string | null) => (v ? new Date(v) : null);

const toRoom = (r: RoomRow): RoomRecord => ({
  id: r.id,
  code: r.code,
  status: r.status,
  hostPlayerId: r.host_player_id,
  settings: r.settings,
  createdAt: new Date(r.created_at),
  expiresAt: new Date(r.expires_at),
  firstGuestJoinedAt: date(r.first_guest_joined_at),
  closedAt: date(r.closed_at),
  closedReason: r.closed_reason,
  gameStartedAt: date(r.game_started_at ?? null),
  finishedAt: date(r.finished_at ?? null),
  winnerPlayerId: r.winner_player_id ?? null,
});

const toPlayer = (p: PlayerRow): PlayerRecord => ({
  id: p.id,
  roomId: p.room_id,
  playerId: p.player_id,
  tokenHash: p.token_hash,
  nickname: p.nickname,
  characterId: p.character_id,
  isHost: p.is_host,
  joinedAt: new Date(p.joined_at),
  leftAt: date(p.left_at),
  isBot: p.is_bot ?? false,
  botPersonality: p.bot_personality ?? null,
});

function fail(action: string, error: { message: string }): never {
  throw new Error(`Supabase ${action} failed: ${error.message}`);
}

export class SupabaseRoomRepository implements RoomRepository {
  constructor(private readonly db: SupabaseClient) {}

  async createRoom(input: NewRoom): Promise<RoomRecord> {
    const { data, error } = await this.db
      .from("rooms")
      .insert({ code: input.code, host_player_id: input.hostPlayerId, settings: input.settings, expires_at: input.expiresAt.toISOString() })
      .select()
      .single<RoomRow>();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) throw new CodeTakenError();
      fail("createRoom", error);
    }
    return toRoom(data);
  }

  async getActiveByCode(code: string): Promise<RoomRecord | null> {
    const { data, error } = await this.db.from("rooms").select().eq("code", code).neq("status", "closed").maybeSingle<RoomRow>();
    if (error) fail("getActiveByCode", error);
    return data ? toRoom(data) : null;
  }

  async updateRoom(roomId: string, patch: RoomPatch): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.hostPlayerId !== undefined) row.host_player_id = patch.hostPlayerId;
    if (patch.settings !== undefined) row.settings = patch.settings;
    if (patch.firstGuestJoinedAt !== undefined) row.first_guest_joined_at = patch.firstGuestJoinedAt.toISOString();
    if (patch.gameStartedAt !== undefined) row.game_started_at = patch.gameStartedAt.toISOString();
    const { error } = await this.db.from("rooms").update(row).eq("id", roomId);
    if (error) fail("updateRoom", error);
  }

  async addPlayer(input: NewPlayer): Promise<PlayerRecord> {
    const { data, error } = await this.db
      .from("room_players")
      .insert({
        room_id: input.roomId,
        player_id: input.playerId,
        token_hash: input.tokenHash,
        nickname: input.nickname,
        is_host: input.isHost,
        ...(input.isBot ? { is_bot: true, bot_personality: input.botPersonality ?? null } : {}),
      })
      .select()
      .single<PlayerRow>();
    if (error) fail("addPlayer", error);
    return toPlayer(data);
  }

  async updatePlayer(roomId: string, playerId: string, patch: PlayerPatch): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.characterId !== undefined) row.character_id = patch.characterId;
    if (patch.isHost !== undefined) row.is_host = patch.isHost;
    if (patch.leftAt !== undefined) row.left_at = patch.leftAt ? patch.leftAt.toISOString() : null;
    const { error } = await this.db.from("room_players").update(row).eq("room_id", roomId).eq("player_id", playerId);
    if (error) {
      if (error.code === UNIQUE_VIOLATION) throw new CharacterTakenError();
      fail("updatePlayer", error);
    }
  }

  async closeRoom(roomId: string, reason: ClosedReason): Promise<void> {
    const { error } = await this.db
      .from("rooms")
      .update({ status: "closed", closed_at: new Date().toISOString(), closed_reason: reason })
      .eq("id", roomId);
    if (error) fail("closeRoom", error);
  }

  async finishGame(roomId: string, winnerPlayerId: string, finishedAt: Date): Promise<void> {
    const iso = finishedAt.toISOString();
    const { error } = await this.db
      .from("rooms")
      .update({ status: "closed", closed_at: iso, closed_reason: "GAME_OVER", finished_at: iso, winner_player_id: winnerPlayerId })
      .eq("id", roomId);
    if (error) fail("finishGame", error);
  }

  async closeAllActive(reason: ClosedReason): Promise<number> {
    const { data, error } = await this.db
      .from("rooms")
      .update({ status: "closed", closed_at: new Date().toISOString(), closed_reason: reason })
      .neq("status", "closed")
      .select("id");
    if (error) fail("closeAllActive", error);
    return data?.length ?? 0;
  }

  async deleteRoom(roomId: string): Promise<void> {
    const { error } = await this.db.from("rooms").delete().eq("id", roomId);
    if (error) fail("deleteRoom", error);
  }
}
