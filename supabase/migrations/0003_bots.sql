-- Deal Rush: computer players (bots). Run once in the Supabase SQL Editor, after 0001 and 0002.
-- A bot is a row in room_players with is_bot = true and the personality it was given.

alter table public.room_players
  add column if not exists is_bot boolean not null default false,
  add column if not exists bot_personality text;
