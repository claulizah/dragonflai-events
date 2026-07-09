-- ══════════════════════════════════════════════════════════════
--  DragonflAI Events — Sistema completo de accesos (DIY + Planner)
--  Reemplaza el "paid" booleano por créditos por evento + vencimiento anual
--  Corre esto en Supabase → SQL Editor → Run
-- ══════════════════════════════════════════════════════════════

-- ── Nuevas columnas en profiles: créditos y vencimientos, por separado para DIY y Planner ──
alter table public.profiles add column diy_event_credits int not null default 0;
alter table public.profiles add column diy_unlimited_until timestamptz;
alter table public.profiles add column planner_event_credits int not null default 0;
alter table public.profiles add column planner_unlimited_until timestamptz;

-- ── Marca de agua: saber si la invitación se publicó con acceso Planner ──
alter table public.invitations add column published_via_planner boolean not null default false;

-- ── Cada plan guardado puede quedar "desbloqueado" (ya se le gastó/aplicó un crédito) ──
alter table public.plans add column full_access_unlocked boolean not null default false;
alter table public.plans add column unlocked_via text; -- 'diy_credit' | 'diy_unlimited' | 'planner_credit' | 'planner_unlimited'

-- ══════════════════════════════════════════════════════════════
--  Función central: intenta desbloquear un plan específico.
--  Es la ÚNICA forma de gastar un crédito — así nunca se puede
--  hacer trampa desde el navegador, todo pasa por aquí y es atómico.
-- ══════════════════════════════════════════════════════════════
create or replace function public.unlock_plan_access(p_plan_id uuid, p_access_type text)
returns jsonb as $$
declare
  v_plan record;
  v_profile record;
begin
  if p_access_type not in ('diy','planner') then
    return jsonb_build_object('success', false, 'reason', 'invalid_access_type');
  end if;

  select * into v_plan from public.plans where id = p_plan_id and user_id = auth.uid();
  if v_plan is null then
    return jsonb_build_object('success', false, 'reason', 'plan_not_found');
  end if;

  -- Ya estaba desbloqueado (con cualquiera de los dos accesos) — no se cobra de nuevo
  if v_plan.full_access_unlocked then
    return jsonb_build_object('success', true, 'method', 'already_unlocked');
  end if;

  select * into v_profile from public.profiles where id = auth.uid();

  -- 1) ¿Tiene anual vigente del tipo pedido?
  if p_access_type = 'diy' and v_profile.diy_unlimited_until is not null and v_profile.diy_unlimited_until > now() then
    update public.plans set full_access_unlocked = true, unlocked_via = 'diy_unlimited' where id = p_plan_id;
    return jsonb_build_object('success', true, 'method', 'diy_unlimited');
  end if;

  if p_access_type = 'planner' and v_profile.planner_unlimited_until is not null and v_profile.planner_unlimited_until > now() then
    update public.plans set full_access_unlocked = true, unlocked_via = 'planner_unlimited' where id = p_plan_id;
    return jsonb_build_object('success', true, 'method', 'planner_unlimited');
  end if;

  -- 2) ¿Tiene créditos de evento del tipo pedido? (Planner también sirve para desbloquear DIY,
  --    porque Planner incluye todo lo de DIY — ver nota de diseño)
  if p_access_type = 'diy' then
    if v_profile.diy_event_credits > 0 then
      update public.profiles set diy_event_credits = diy_event_credits - 1 where id = auth.uid();
      update public.plans set full_access_unlocked = true, unlocked_via = 'diy_credit' where id = p_plan_id;
      return jsonb_build_object('success', true, 'method', 'diy_credit', 'remaining', v_profile.diy_event_credits - 1);
    elsif v_profile.planner_event_credits > 0 then
      update public.profiles set planner_event_credits = planner_event_credits - 1 where id = auth.uid();
      update public.plans set full_access_unlocked = true, unlocked_via = 'planner_credit' where id = p_plan_id;
      return jsonb_build_object('success', true, 'method', 'planner_credit', 'remaining', v_profile.planner_event_credits - 1);
    end if;
  end if;

  -- 3) Propuesta de cliente (modo Planner) — SOLO créditos/anual de Planner, DIY no aplica aquí
  if p_access_type = 'planner' then
    if v_profile.planner_event_credits > 0 then
      update public.profiles set planner_event_credits = planner_event_credits - 1 where id = auth.uid();
      update public.plans set full_access_unlocked = true, unlocked_via = 'planner_credit' where id = p_plan_id;
      return jsonb_build_object('success', true, 'method', 'planner_credit', 'remaining', v_profile.planner_event_credits - 1);
    end if;
  end if;

  return jsonb_build_object('success', false, 'reason', 'no_credits');
end;
$$ language plpgsql security definer;

grant execute on function public.unlock_plan_access(uuid,text) to authenticated;

-- ══════════════════════════════════════════════════════════════
--  Función de solo lectura: para saber qué mostrar en la UI sin gastar nada
--  (ej. "¿ya tienes acceso a este plan?" antes de intentar desbloquear)
-- ══════════════════════════════════════════════════════════════
create or replace function public.get_my_access_summary()
returns jsonb as $$
declare
  v_profile record;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  return jsonb_build_object(
    'diy_event_credits', coalesce(v_profile.diy_event_credits, 0),
    'diy_unlimited_active', v_profile.diy_unlimited_until is not null and v_profile.diy_unlimited_until > now(),
    'diy_unlimited_until', v_profile.diy_unlimited_until,
    'planner_event_credits', coalesce(v_profile.planner_event_credits, 0),
    'planner_unlimited_active', v_profile.planner_unlimited_until is not null and v_profile.planner_unlimited_until > now(),
    'planner_unlimited_until', v_profile.planner_unlimited_until
  );
end;
$$ language plpgsql security definer;

grant execute on function public.get_my_access_summary() to authenticated;

-- ══════════════════════════════════════════════════════════════
--  Función simple para gastar un crédito de Planner al GENERAR una propuesta.
--  (Distinta de unlock_plan_access: esta se usa en el momento de generar,
--  antes de que el plan tenga un id guardado. Regenerar dentro de la misma
--  sesión del navegador no vuelve a cobrar — eso se controla del lado de la app.)
-- ══════════════════════════════════════════════════════════════
create or replace function public.spend_planner_credit()
returns jsonb as $$
declare
  v_profile record;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if v_profile is null then
    return jsonb_build_object('success', false, 'reason', 'no_profile');
  end if;

  if v_profile.planner_unlimited_until is not null and v_profile.planner_unlimited_until > now() then
    return jsonb_build_object('success', true, 'method', 'planner_unlimited');
  end if;

  if v_profile.planner_event_credits > 0 then
    update public.profiles set planner_event_credits = planner_event_credits - 1 where id = auth.uid();
    return jsonb_build_object('success', true, 'method', 'planner_credit', 'remaining', v_profile.planner_event_credits - 1);
  end if;

  return jsonb_build_object('success', false, 'reason', 'no_credits');
end;
$$ language plpgsql security definer;

grant execute on function public.spend_planner_credit() to authenticated;
