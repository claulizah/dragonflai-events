-- ══════════════════════════════════════════════════════════════
--  DragonflAI Events — Corregir el candado de "Publicar invitación"
--  Antes revisaba profiles.paid (sí/no genérico). Ahora que existen
--  créditos por evento, debe revisar que el plan específico que se está
--  publicando ya tenga full_access_unlocked = true (se marca así en
--  unlock_plan_access cuando el usuario gasta un crédito o tiene anual vigente).
--  Corre esto en Supabase → SQL Editor → Run
-- ══════════════════════════════════════════════════════════════

drop policy if exists "Solo cuentas pagadas pueden crear invitaciones" on public.invitations;

-- Función aislada para verificar el desbloqueo — evita depender de que el RLS
-- de "plans" se evalúe correctamente DENTRO de la política de "invitations"
-- (Postgres puede comportarse de forma inconsistente con RLS anidado).
create or replace function public.is_plan_unlocked(p_plan_id uuid, p_user_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.plans
    where id = p_plan_id and user_id = p_user_id and full_access_unlocked = true
  );
$$ language sql security definer stable;

grant execute on function public.is_plan_unlocked(uuid,uuid) to authenticated;

create policy "Solo se puede publicar un plan ya desbloqueado"
  on public.invitations for insert
  with check (
    auth.uid() = user_id
    and plan_id is not null
    and public.is_plan_unlocked(plan_id, auth.uid())
  );
