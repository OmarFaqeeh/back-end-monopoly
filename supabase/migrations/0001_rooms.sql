-- Deal Rush: rooms and room players (back-end phase 1).
-- Run this once in the Supabase SQL Editor. gen_random_uuid() is built in on Supabase (Postgres 13+).

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[0-9]{6}$'),
  status text not null default 'waiting' check (status in ('waiting','playing','closed')),
  host_player_id uuid,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  first_guest_joined_at timestamptz,
  closed_at timestamptz,
  closed_reason text
);

-- One active room per code; a closed room frees its code.
create unique index rooms_active_code_uidx on public.rooms (code) where status <> 'closed';

create table public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null,
  token_hash text not null,
  nickname text not null,
  character_id text,
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  unique (room_id, player_id)
);

-- A character can be used once per room by a player who has not left.
create unique index room_players_character_uidx
  on public.room_players (room_id, character_id)
  where character_id is not null and left_at is null;

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
-- No policies on purpose: the browser roles (anon, authenticated) get no access.
-- Only the Express server, using the service role key (which bypasses RLS), reads and writes these tables.
