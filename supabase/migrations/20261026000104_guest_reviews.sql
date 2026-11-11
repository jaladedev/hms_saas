-- 104 Guest reviews: collected after the stay, moderated by the hotel, shown on the guest homepage.
--
-- A guest whose booking is checked out may leave one review: a rating of 1 to 5 and an optional comment (up to 1000 characters). It
-- starts pending and appears on the website only after the hotel approves it. A review is never edited by the hotel (only approved or
-- rejected) and never deleted by anyone through the app.
--
--   guest_reviews            one row per booking (unique reservation_id). `author` is the guest's first name and last initial,
--                            made when the review is written ("Ada O."), so the public never sees a full name or an email.
--                            Staff with property.configure may read; all writes go through the functions below.
--   guest_review_state(r)    service_role: whether this booking can be reviewed and its review if any. For the booking page.
--   submit_guest_review(r, rating, comment)
--                            service_role (the guest's signed booking link was checked by the app): INVALID_STATE: not stayed unless
--                            the booking is checked out; CONFLICT: reviewed for a second review; POLICY_VIOLATION: rating | comment.
--   moderate_guest_review(review, decision)
--                            property.configure at the hotel; decision 'approved' or 'rejected' (a later decision replaces an earlier
--                            one). NOT_FOUND for no permission, another hotel or unknown. Audited as guest_review.moderated.
--   guest_reviews_public(host)
--                            service_role: the average rating and count of approved reviews, and the newest six (rating, comment,
--                            author, month). No ids, tenant or property.

create table guest_reviews (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  reservation_id uuid not null unique references reservations(id),
  rating         smallint not null check (rating between 1 and 5),
  comment        text not null default '' check (length(comment) <= 1000),
  author         text not null check (length(author) between 1 and 60),
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at     timestamptz not null default now(),
  moderated_by   uuid,
  moderated_at   timestamptz,
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
create index guest_reviews_property_idx on guest_reviews (property_id, status, created_at desc);

alter table guest_reviews enable row level security;
create policy guest_reviews_select on guest_reviews for select to authenticated using (has_permission(property_id, 'property.configure'));
revoke insert, update, delete on guest_reviews from authenticated, anon;

create function guest_review_state(p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; g guest_reviews%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from guest_reviews where reservation_id = r.id;
  return jsonb_build_object(
    'can_review', r.reservation_status = 'checked_out' and g.id is null,
    'review', case when g.id is null then null
              else jsonb_build_object('rating', g.rating, 'comment', g.comment, 'status', g.status) end);
end $$;
revoke all on function guest_review_state(uuid) from public, anon, authenticated;
grant execute on function guest_review_state(uuid) to service_role;

create function submit_guest_review(p_reservation_id uuid, p_rating integer, p_comment text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_comment text := btrim(coalesce(p_comment, '')); v_name text; v_parts text[]; v_author text; v_id uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if r.reservation_status <> 'checked_out' then raise exception 'INVALID_STATE: not stayed' using errcode = 'P0001'; end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'POLICY_VIOLATION: rating' using errcode = 'P0001'; end if;
  if length(v_comment) > 1000 then raise exception 'POLICY_VIOLATION: comment' using errcode = 'P0001'; end if;
  if exists (select 1 from guest_reviews where reservation_id = r.id) then raise exception 'CONFLICT: reviewed' using errcode = 'P0001'; end if;

  select btrim(full_name) into v_name from guests where id = r.primary_guest_id;
  v_parts := regexp_split_to_array(coalesce(nullif(v_name, ''), 'Guest'), '\s+');
  v_author := left(v_parts[1], 40) || case when array_length(v_parts, 1) > 1 then ' ' || upper(left(v_parts[array_length(v_parts, 1)], 1)) || '.' else '' end;

  insert into guest_reviews (tenant_id, property_id, reservation_id, rating, comment, author)
  values (r.tenant_id, r.property_id, r.id, p_rating, v_comment, v_author)
  returning id into v_id;
  return jsonb_build_object('review_id', v_id);
end $$;
revoke all on function submit_guest_review(uuid, integer, text) from public, anon, authenticated;
grant execute on function submit_guest_review(uuid, integer, text) to service_role;

create function moderate_guest_review(p_review uuid, p_decision text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guest_reviews%rowtype; v_actor uuid;
begin
  select * into g from guest_reviews where id = p_review;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(g.property_id, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;   -- a person, never the system
  if p_decision is null or p_decision not in ('approved', 'rejected') then raise exception 'POLICY_VIOLATION: decision' using errcode = 'P0001'; end if;
  if g.status <> p_decision then
    update guest_reviews set status = p_decision, moderated_by = v_actor, moderated_at = now() where id = g.id;
    perform write_audit(g.tenant_id, g.property_id, v_actor, 'guest_review.moderated', 'guest_review', g.id, null,
                        jsonb_build_object('from', g.status, 'to', p_decision, 'rating', g.rating));
  end if;
  return jsonb_build_object('review_id', g.id, 'status', p_decision, 'changed', g.status <> p_decision);
end $$;
revoke all on function moderate_guest_review(uuid, text) from public, anon;
grant execute on function moderate_guest_review(uuid, text) to authenticated;

create function guest_reviews_public(p_host text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid; v_avg numeric; v_n integer;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select round(avg(rating), 1), count(*) into v_avg, v_n from guest_reviews where property_id = v_property and status = 'approved';
  return jsonb_build_object(
    'average', v_avg, 'count', v_n,
    'reviews', coalesce((select jsonb_agg(jsonb_build_object('rating', x.rating, 'comment', x.comment, 'author', x.author,
                                                              'month', to_char(x.created_at, 'YYYY-MM')) order by x.created_at desc)
                           from (select * from guest_reviews where property_id = v_property and status = 'approved'
                                  order by created_at desc limit 6) x), '[]'::jsonb));
end $$;
revoke all on function guest_reviews_public(text) from public, anon, authenticated;
grant execute on function guest_reviews_public(text) to service_role;
