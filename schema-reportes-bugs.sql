-- ══════════════════════════════════════════════════════════════
--  DragonflAI Events — Reportes de bugs de beta testers
--  Corre esto en Supabase → SQL Editor → Run
-- ══════════════════════════════════════════════════════════════

create table public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  page text,            -- en qué página estaban (landing / app / invitación)
  message text not null,
  browser_info text,    -- user agent, útil para reproducir el problema
  status text not null default 'nuevo' check (status in ('nuevo','revisando','resuelto')),
  created_at timestamptz not null default now()
);

alter table public.bug_reports enable row level security;

-- Cualquiera puede mandar un reporte, esté o no loggeado —
-- pueden encontrar un bug antes de iniciar sesión.
create policy "Cualquiera puede reportar un problema"
  on public.bug_reports for insert
  with check (true);

-- Solo tú (con tu acceso de administrador en Supabase) puedes leerlos —
-- no hay política de SELECT pública a propósito.

-- ══════════════════════════════════════════════════════════════
--  Para revisar los reportes nuevos, corre esto cuando quieras:
-- ══════════════════════════════════════════════════════════════
-- select created_at, page, user_email, message, status
-- from public.bug_reports
-- order by created_at desc;
