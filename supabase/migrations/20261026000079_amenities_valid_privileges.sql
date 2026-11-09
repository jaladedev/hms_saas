-- 079 amenities_valid is not callable by the public API role anon.
--
-- 077 created amenities_valid(text[]) for a CHECK constraint on room_types and did not revoke the EXECUTE that Postgres gives
-- every new function. docs/STAGING.md step 4c expects exactly three functions callable by anon (has_permission,
-- has_tenant_permission, my_tenant_ids), and this was a fourth. It is a pure validator that reads no data, so nothing leaked,
-- but the checklist says any difference is a stop. Same fix as policy_config_valid (035): revoke from public and anon.
-- authenticated keeps EXECUTE on purpose: a CHECK constraint is evaluated with the caller's rights, and staff edit room types
-- as authenticated. 077 is left as it was because it is already in the repository.

revoke all on function amenities_valid(text[]) from public, anon;
