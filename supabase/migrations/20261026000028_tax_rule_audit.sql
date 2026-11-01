-- 028 Audit for tax rules.
--
-- Tax rules are written straight from the staff screens under row-level security (people with property.configure),
-- and since 027 a rule can be marked applies_to_charges, which decides whether extras on a folio are taxed. Changing
-- that, or a rate, changes the money on every charge posted afterwards, so who did it must be on record.
--
-- This reuses audit_setup_row() from 024, so the entries look like the other setup changes:
--   tax_rule.created / tax_rule.updated / tax_rule.deleted, entity_type tax_rule, entity_id the rule.
--   metadata: {"values": {...}} on create and delete, {"changed": {"column": {"from": .., "to": ..}}} on update.
-- Only the columns that change what is charged are watched; an update that changes none of them writes nothing.
-- The actor is auth.uid(), or null for the service role and database scripts. Posted charges keep the tax they were
-- posted with (027 stores it on the charge), so a rule change is never applied backwards.

create trigger tax_rules_audit after insert or update or delete on tax_rules
  for each row execute function audit_setup_row('tax_rule',
    'name,basis,rate_value,sequence,compounds,effective_from,effective_to,status,applies_to_charges');
