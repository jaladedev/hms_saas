-- AI reply drafts (migration 179). Hotel A: owner aa01, front desk aa04, housekeeping aa02, other hotel's owner bb01.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_m uuid; c jsonb;
begin
  perform t_sys();
  delete from contact_messages;
  v_m := (guest_send_message('book.hotel-a.test', 'Ada Okafor', 'ada.secret@example.com', 'Do you have parking for two cars?') ->> 'message_id')::uuid;
  if not ('ai_helpers' = any (plan_enforced_flags())) then raise exception 'FAIL flag not enforced'; end if;

  -- off: no entitlement row means off, unlike the other flags
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if ai_helpers_on(v_p) then raise exception 'FAIL on without the flag'; end if;
  perform t_expect(format('select ai_reply_context(%L)', v_m), 'POLICY_VIOLATION: ai off');

  -- switched on for the hotel group on purpose
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'ai_helpers', false);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if ai_helpers_on(v_p) then raise exception 'FAIL on with the flag set off'; end if;
  perform t_sys();
  update tenant_feature_entitlements set enabled = true where tenant_id = v_t and feature_key = 'ai_helpers';

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if not ai_helpers_on(v_p) then raise exception 'FAIL not on with the flag'; end if;
  c := ai_reply_context(v_m);
  if c ->> 'first_name' <> 'Ada' or c ->> 'message' <> 'Do you have parking for two cars?' or c ->> 'hotel' is null then raise exception 'FAIL context %', c; end if;
  if c::text like '%secret%' or c::text like '%Okafor%' then raise exception 'FAIL personal data in the context %', c; end if;

  -- who may
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if ai_helpers_on(v_p) then raise exception 'FAIL housekeeping can use it'; end if;
  perform t_expect(format('select ai_reply_context(%L)', v_m), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if ai_helpers_on(v_p) then raise exception 'FAIL other hotel can use it'; end if;
  perform t_expect(format('select ai_reply_context(%L)', v_m), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select ai_reply_context(%L)', gen_random_uuid()), 'NOT_FOUND');

  -- take the row away again: off
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'ai_helpers';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if ai_helpers_on(v_p) then raise exception 'FAIL still on'; end if;
  raise notice 'PASS ai reply drafts: flag enforced and off by default, context holds first name and message only, permission and hotel scoped';
end $$;
