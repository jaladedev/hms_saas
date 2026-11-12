-- 115 The hotel's own notice of platform access: when someone from the platform looked at the hotel's setup.
--
-- Migration 111 lets platform staff, with another admin's approval, read a hotel group's setup for 1, 4 or 24 hours. The hotel should be
-- able to see that it happened. hotel_platform_access(property) is for someone with property.configure at that hotel (the owner and
-- general manager, like hotel setup and billing); anyone else, another hotel or an unknown property gets NOT_FOUND.
--
-- It lists the windows that were actually approved, newest first, at most 50: when it was approved, until when, whether it ended early,
-- (ended_early only when it was stopped before its time; a window that simply ran out reads finished), how many times the setup was opened and when last. Each row also says what a window is: a read-only view of setup, never guests,
-- bookings, payments or secrets (the app says it in words). It does NOT return who asked or who approved, the reason, the ticket or
-- the decision note: those are internal to the platform. Requests that were only asked, denied, withdrawn or never decided are not
-- listed (nothing was opened). This is a notice, not a consent step: approval stays with a platform admin.

create function hotel_platform_access(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from properties where id = p_property;
  if v_tenant is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  return coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.approved_at desc) from (
    select r.id, r.decided_at as approved_at, r.hours,
           r.approved_until as until,
           r.ended_at,
           case when r.ended_at is not null and r.ended_at < r.approved_until then 'ended_early'
                when r.ended_at is null and r.approved_until > now() then 'open'
                else 'finished' end as state,
           r.views, r.last_viewed_at
      from access_requests r
     where r.tenant_id = v_tenant and r.approved_until is not null and r.decided_at is not null
     order by r.decided_at desc
     limit 50) x), '[]'::jsonb);
end $$;
revoke all on function hotel_platform_access(uuid) from public, anon;
grant execute on function hotel_platform_access(uuid) to authenticated;
