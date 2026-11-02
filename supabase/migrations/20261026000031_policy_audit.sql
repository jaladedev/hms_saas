-- 031 Audit for policy versions.
--
-- Cancellation and payment policies are written straight from /app/settings/policies under row-level security
-- (people with property.configure). A policy decides what a cancellation costs and what a guest pays online, so
-- who published each version must be on record. Rows are immutable (005), so only inserts are audited:
--   property_policy.created, entity_type property_policy, entity_id the row.
--   metadata: {"values": {"version": .., "effective_from": .., "config": {..}}}
-- The actor is auth.uid(), or null for the service role and database scripts. Reuses audit_setup_row() from 024.
-- The setup history screen does not list these rows yet (its filters name actions outright).

create trigger property_policies_audit after insert on property_policies
  for each row execute function audit_setup_row('property_policy', 'version,effective_from,config');
