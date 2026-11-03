-- 034 Room board views: what the room board needs, without rates or guests.
--
-- The board (/app/rooms) is open to everyone who holds room.view: housekeeping and maintenance included. Until now it
-- read rooms, room_types, claims, reservation_rooms, reservations and guests directly, so a login without
-- reservation.view could not tell an occupied room from one with a guest still to arrive (reservation_rooms was hidden),
-- and could not see room type names (room_types carries base rates, so 003 hides it from them: "they get a purpose-built
-- room board view later").
--
-- Two views, both filtered by room.view at the room's property, so each person sees only the properties they may:
--
--   room_board_view         one row per room: the room, its type's NAME (never a rate), and its service and cleaning status.
--   room_board_claims_view  the active stays, holds and blocks on those rooms, plus checked_in: true when the guest of a
--                           stay is in the room. That is the one fact about a booking the board needs for everyone;
--                           reservation_room_id is given only to people who may read reservations (reservation.view),
--                           since the board uses it to link to the booking.
--
-- Neither view holds a guest, a booking reference, a price, a payment or a tax. They are owned by the table owner, so they
-- read the base tables without row-level security; the room.view test inside each view is what limits the rows, and
-- security_barrier stops a caller's own function from seeing rows before that test runs. anon gets nothing.
-- (Supabase's security advisor flags any view that bypasses row-level security; these two are meant to, and the tests
-- in 38_room_board_views.sql pin down exactly what each login can and cannot read through them.)

create view room_board_view with (security_barrier = true) as
select r.id, r.property_id, r.room_type_id, t.name as room_type_name, r.room_number, r.floor,
       r.operational_status, r.housekeeping_status
  from rooms r
  join room_types t on t.id = r.room_type_id
 where has_permission(r.property_id, 'room.view');

create view room_board_claims_view with (security_barrier = true) as
select c.id, c.property_id, c.room_id, c.claim_type, c.start_date, c.end_date,
       case when has_permission(c.property_id, 'reservation.view') then c.reservation_room_id end as reservation_room_id,
       c.block_reason,
       coalesce(rr.room_status = 'checked_in', false) as checked_in
  from room_inventory_claims c
  left join reservation_rooms rr on rr.id = c.reservation_room_id
 where c.status = 'active'
   and has_permission(c.property_id, 'room.view');

revoke all on room_board_view, room_board_claims_view from public, anon, authenticated;
grant select on room_board_view, room_board_claims_view to authenticated;
