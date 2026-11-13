-- 123 Room status events are ordered by when each change happened, not by when its transaction began.
--
-- 120 stamped created_at with now(), which is the start of the transaction: two changes made in one transaction (a script, a
-- test, a staff action that changes two things) got the same time, and the history then fell back to the random id to say which
-- was newest. clock_timestamp() is the moment of each insert, so the order is the order of the changes. Existing rows keep
-- their time; nothing else changes.

alter table room_status_events alter column created_at set default clock_timestamp();
