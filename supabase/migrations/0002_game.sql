-- Deal Rush: game columns on rooms (phase 2). Run once in the Supabase SQL Editor, after 0001_rooms.sql.
-- A finished game closes its room with closed_reason = 'GAME_OVER' and records who won.

alter table public.rooms
  add column if not exists game_started_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists winner_player_id uuid;
