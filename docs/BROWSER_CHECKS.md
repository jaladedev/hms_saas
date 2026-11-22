# Browser checks for features built without a browser

Everything below passed the database suite, unit tests, typecheck, lint and `next build`, but nobody has clicked through it yet. Tick a box when you have seen it work on staging with a signed-in owner. "Expect" is what you should see; if it differs, note the page and what happened.

Set up once: a staging hotel on a plan with these flags on (Platform > hotel group > plan): `loyalty`, `group_bookings`, `channel_manager`, `sms_notifications`, `pricing_rules`, `staff_hr`, `services`. Create one room type with a rate and 3 rooms.

## 8.4 Vouchers and loyalty
- [ ] `/app/settings/loyalty` opens (it used to be a dead link). Save a points rule. Expect "saved", values stay after reload.
- [ ] `/app/settings/vouchers`: issue a gift voucher of 20,000. Expect a code like `GV-XXXX-XXXX` shown once in the list with balance 20,000.
- [ ] Open a new booking's page, enter the code in the voucher card. Expect the balance to drop by the amount applied and the booking's outstanding to fall.
- [ ] Void an unspent voucher. Expect status void; a spent one refuses with a clear message.

## 8.5 Automatic pricing
- [ ] `/app/settings/pricing`: add an occupancy rule, switch automatic apply on. Expect a preview of suggested prices.
- [ ] Press "Apply now". Expect the calendar rates to change for the next 60 nights; a night you set by hand stays as you set it.
- [ ] Turn automatic apply off and revert. Expect the original rates back.

## 8.6 Channel manager
- [ ] `/app/channels`: create a connection (channel collects payment). Expect the key shown once; copy it.
- [ ] Map a room code to a room type. From a terminal: `curl -H "Authorization: Bearer <key>" "https://<staging>/api/channels/feed?from=<tomorrow>&to=<in 3 days>"`. Expect your room code with 3 days of `available` and `rate_minor`; the screen then says "feed last read".
- [ ] POST a booking to `/api/channels/inbound` (see `lib/channels/inbound.ts` for the shape). Expect it under "Bookings from channels" as Imported with a link to the reservation.
- [ ] Post one with an unmapped room code. Expect "Could not import" with the reason; map the code, wait or press "Try again". Expect Imported.
- [ ] Under "The channel collected the payment", press "Record channel payment". Expect the reservation to become paid, and the row to disappear.
- [ ] Send a modification for the booking (8.6 modify, migration 177). Expect it applied or listed as needing a person.
- [ ] Send 31 feed calls inside a minute. Expect the 31st to answer 429 with `Retry-After`.

## 8.7 Groups and companies
- [ ] `/app/groups/companies`: create a company with a +234 billing phone. Turn on "Text overdue invoice reminders" and set a hold of 15 days.
- [ ] `/app/groups`: create a group, link the company, add rooms, issue an invoice with a due date in the past (staging only: change `due_date` in the database).
- [ ] Run the maintenance job (`GET /api/cron/maintenance` with the cron secret). Expect an email row and (if texting is on for the hotel) a text row on the invoice page under reminders, outcome Queued or Sent.
- [ ] With the invoice 16+ days overdue, try linking another group to that company. Expect the "on hold" message. Mark the invoice paid; link again. Expect success.
- [ ] Company credit: deposit, apply to a group invoice, withdraw. Expect the balance to follow each step.
- [ ] `/app/groups/overdue` lists the late invoices.

## 8.8 Night audit
- [ ] Run a day close with an arrival not checked in. Expect it listed; close after resolving. Expect the day locked.

## 8.9 API keys
- [ ] `/app/settings/api`: create a key with `availability.read`. `curl` `/api/v1/availability`. Expect JSON. Revoke it; the same call returns 401.

## 8.10 Currency
- [ ] `/app/settings/currency`: view the hotel currency and set a rate. Expect money on the guest site to follow the hotel currency.

## 8.11 Staff HR
- [ ] `/app/staff`: add a shift, clock in and out, request and approve leave, export the hours CSV. Expect a shift on approved leave to be refused.

## 8.12 Services
- [ ] `/app/settings/services`: add a spa service with capacity 2. Book three at the same time. Expect the third refused. Post one to a room's folio.

## Other recent
- [ ] Payment receipts (migration 178): on a paid booking, open Documents and download the receipt PDF.
- [ ] Bulk room status change on `/app/rooms`: select 3 rooms, set one status. Expect all three to change, and any room with a stay in progress to be refused with a reason.
