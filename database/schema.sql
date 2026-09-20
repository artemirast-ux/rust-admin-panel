-- ============================================================================
-- RustAdminPanel — database schema for Supabase (free tier)
-- Open: Supabase dashboard -> SQL Editor -> New query -> paste this -> Run
-- ============================================================================

-- Admins: emails that are allowed to log into the web panel
create table if not exists admins (
  id        bigint primary key generated always as identity,
  email     text not null unique,
  role      text not null default 'admin',
  created_at timestamptz not null default now()
);

-- Players
create table if not exists players (
  steamid          text primary key,
  name             text,
  ip               text,
  hwid             text,
  country          text,
  country_code     text,
  isp              text,
  asn              text,
  proxy_type       text,
  is_vpn           boolean not null default false,
  vpn_checked      boolean not null default false,
  ping             int  not null default 0,
  online           boolean not null default false,
  first_seen       timestamptz not null default now(),
  last_seen        timestamptz not null default now(),
  times_connected  int  not null default 0
);

-- Bans (by SteamID and/or IP and/or HWID)
create table if not exists bans (
  id               bigint primary key generated always as identity,
  steamid          text,
  ip               text,
  hwid             text,
  name             text,
  reason           text not null default 'Banned',
  duration_minutes bigint,                 -- null = permanent
  expires_at       timestamptz,            -- null = permanent
  admin            text not null default 'panel',
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unbanned_by      text,
  unbanned_at      timestamptz
);

-- Mutes
create table if not exists mutes (
  id               bigint primary key generated always as identity,
  steamid          text not null,
  name             text,
  reason           text not null default 'Muted',
  duration_minutes bigint,
  expires_at       timestamptz,
  admin            text not null default 'panel',
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unmuted_by       text,
  unmuted_at       timestamptz
);

-- Kicks history
create table if not exists kicks (
  id        bigint primary key generated always as identity,
  steamid   text,
  name      text,
  reason    text not null default '',
  admin     text not null default 'panel',
  created_at timestamptz not null default now()
);

-- Reports from players (/report and F7)
create table if not exists reports (
  id              bigint primary key generated always as identity,
  reporter_steamid text,
  reporter_name   text,
  target_steamid  text,
  target_name     text,
  reason          text,
  source          text not null default 'chat',   -- chat | f7
  status          text not null default 'pending', -- pending | reviewed | banned
  created_at      timestamptz not null default now()
);

-- Kill log
create table if not exists kills (
  id              bigint primary key generated always as identity,
  attacker_steamid text,
  attacker_name   text,
  victim_steamid  text,
  victim_name     text,
  weapon          text,
  distance        float,
  headshot        boolean not null default false,
  created_at      timestamptz not null default now()
);

-- Chat log
create table if not exists chat_logs (
  id         bigint primary key generated always as identity,
  steamid    text,
  name       text,
  message    text,
  created_at timestamptz not null default now()
);

-- Connection log
create table if not exists connection_logs (
  id         bigint primary key generated always as identity,
  steamid    text,
  name       text,
  ip         text,
  type       text not null,              -- join | quit
  created_at timestamptz not null default now()
);

-- Commands: site -> plugin (ban/kick/mute/unban/...)
create table if not exists commands (
  id               bigint primary key generated always as identity,
  command          text not null,        -- kick|ban|unban|mute|unmute|say|broadcast|console|checkip
  steamid          text,
  ip               text,
  hwid             text,
  name             text,
  reason           text,
  message          text,
  duration_minutes bigint,
  admin            text not null default 'panel',
  status           text not null default 'pending', -- pending|done|failed
  result           text,
  created_at       timestamptz not null default now(),
  executed_at      timestamptz
);

-- IP checks history (VPN/proxy lookups, also from manual "checkip" on the site)
create table if not exists ip_checks (
  id           bigint primary key generated always as identity,
  steamid      text,
  name         text,
  ip           text not null,
  is_vpn       boolean not null default false,
  proxy_type   text,
  country      text,
  country_code text,
  isp          text,
  asn          text,
  risk         int,
  source       text not null default 'auto',   -- auto | manual
  created_at   timestamptz not null default now()
);

-- Server status (single row, id = 1)
create table if not exists server_status (
  id              bigint primary key default 1,
  hostname        text,
  players_online  int  not null default 0,
  max_players     int  not null default 0,
  fps             int  not null default 0,
  last_heartbeat  timestamptz not null default now()
);

-- Online player count history, one row per interval. Feeds the dashboard chart.
create table if not exists online_history (
  id              bigint primary key generated always as identity,
  players_online  int  not null default 0,
  created_at      timestamptz not null default now()
);

-- "Call for verification" sessions: an admin pulls a player into a private chat
-- from the Reports section of the site and watches what he does until a verdict.
create table if not exists checks (
  id           bigint primary key generated always as identity,
  steamid      text not null,
  name         text,
  admin        text not null default 'panel',
  status       text not null default 'active',  -- active | clean | banned
  shown        boolean not null default false,   -- the in-game notice was shown
  created_at   timestamptz not null default now(),
  closed_at    timestamptz
);

-- Everything that happens inside a verification session: admin messages,
-- player replies, and auto-captured events (kills, chat, connections...).
create table if not exists check_events (
  id         bigint primary key generated always as identity,
  check_id   bigint not null references checks(id) on delete cascade,
  kind       text not null,                 -- msg_admin | msg_player | kill | death | chat | event
  text       text,
  created_at timestamptz not null default now()
);

-- Sleeping bodies ("sleepers"), so the panel can show them on the map like RustApp.
create table if not exists sleepers (
  steamid    text primary key,
  name       text,
  pos_x      int  not null default 0,
  pos_z      int  not null default 0,
  last_seen  timestamptz not null default now()
);

-- Alerts: noteworthy events for the "Оповещения" tab (VPN, reports, bans, checks)
create table if not exists alerts (
  id         bigint primary key generated always as identity,
  kind       text not null,                 -- vpn | report | ban | check
  text       text not null,
  created_at timestamptz not null default now()
);

-- Helper: increment connection counter (called by plugin via rpc)
create or replace function increment_connections(p_steamid text)
returns void
language sql
security definer
as $$
  update players set times_connected = times_connected + 1 where steamid = p_steamid;
$$;

-- Helper: is the current user a panel admin? SECURITY DEFINER runs as the owner,
-- so it bypasses RLS on admins -- otherwise a policy that selects from "admins"
-- recurses into itself ("infinite recursion detected in policy for relation admins").
create or replace function is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (select 1 from admins a where a.email = coalesce(auth.jwt() ->> 'email', ''));
$$;

-- Indexes
create index if not exists idx_bans_steamid  on bans (steamid);
create index if not exists idx_bans_ip       on bans (ip);
create index if not exists idx_bans_hwid     on bans (hwid);
create index if not exists idx_bans_active   on bans (active);
create index if not exists idx_commands_status on commands (status);
create index if not exists idx_players_online  on players (online);
create index if not exists idx_players_ip     on players (ip);
create index if not exists idx_players_hwid   on players (hwid);
create index if not exists idx_mutes_steamid  on mutes (steamid);
create index if not exists idx_reports_status on reports (status);
create index if not exists idx_ip_checks_ip   on ip_checks (ip);
create index if not exists idx_ip_checks_created on ip_checks (created_at desc);
create index if not exists idx_checks_steamid on checks (steamid);
create index if not exists idx_checks_status  on checks (status);
create index if not exists idx_check_events_check on check_events (check_id, created_at);
create index if not exists idx_online_history_created on online_history (created_at desc);
create index if not exists idx_alerts_created  on alerts (created_at desc);
create index if not exists idx_alerts_kind      on alerts (kind);
create index if not exists idx_sleepers_last_seen on sleepers (last_seen desc);

-- ============================================================================
-- Row Level Security: only panel admins (by email) can read/write from site.
-- The plugin uses the service role key, which bypasses RLS entirely.
-- ============================================================================

alter table admins          enable row level security;
alter table players         enable row level security;
alter table bans            enable row level security;
alter table mutes           enable row level security;
alter table kicks           enable row level security;
alter table reports         enable row level security;
alter table kills           enable row level security;
alter table chat_logs       enable row level security;
alter table connection_logs enable row level security;
alter table commands        enable row level security;
alter table server_status   enable row level security;
alter table ip_checks       enable row level security;
alter table checks          enable row level security;
alter table check_events    enable row level security;
alter table online_history  enable row level security;
alter table sleepers        enable row level security;
alter table alerts          enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'admins','players','bans','mutes','kicks','reports','kills',
    'chat_logs','connection_logs','commands','server_status','ip_checks',
    'checks','check_events','online_history','sleepers','alerts'
  ]
  loop
    execute format(
      'drop policy if exists admin_all_%1$s on %1$s;', t);
    execute format(
      'create policy admin_all_%1$s on %1$s for all to authenticated
         using (is_admin())
         with check (is_admin());', t);
  end loop;
end $$;

-- ============================================================================
-- If your database already exists, this block adds the new columns used by the
-- VPN/IP-check features. Safe to run repeatedly (everything is IF NOT EXISTS).
-- ============================================================================
alter table players add column if not exists country_code text;
alter table players add column if not exists isp          text;
alter table players add column if not exists asn          text;
alter table players add column if not exists proxy_type   text;
alter table kills add column if not exists headshot       boolean not null default false;
alter table players add column if not exists pos_x         int  not null default 0;
alter table players add column if not exists pos_z         int  not null default 0;

-- Steam / profile badges (populated by the plugin when a Steam Web API key is set)
alter table players add column if not exists is_pirate            boolean;
alter table players add column if not exists steam_created        timestamptz;
alter table players add column if not exists steam_hours_2week    int;
alter table players add column if not exists rust_hours_total     int;
alter table players add column if not exists spacewar_hours_total int;
alter table players add column if not exists vac_bans             int;
alter table players add column if not exists game_bans            int;
alter table players add column if not exists steam_profile_public boolean;
alter table players add column if not exists steam_checked_at     timestamptz;

-- Live status badges (written on every heartbeat)
alter table players add column if not exists is_alive           boolean;
alter table players add column if not exists raid_blocked       boolean;
alter table players add column if not exists language           text;
alter table players add column if not exists ignore_reports_until timestamptz;

-- ============================================================================
-- After creating your account in Supabase -> Authentication -> Users -> Add user,
-- run this (replace with your email) to give yourself panel access:
--   insert into admins (email, role) values ('you@example.com', 'owner');
-- ============================================================================
