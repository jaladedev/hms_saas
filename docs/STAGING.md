# Staging checklist

Goal: run the real app against a real Supabase project and Paystack TEST mode, and settle the things the local tests
cannot prove. Work top to bottom and write the result next to each step. Stop at the first failure.

**What the local tests already prove** (30 migrations, `npm run db:test`, `npm run e2e`): the rules, row-level
security, the concurrency guarantees, the guest flow, and two staff screens over HTTP with a faked sign-in.

**What only this checklist can prove:**

1. Supabase's real Auth sign-in, cookies and invite emails.
2. `is_system_caller()` with Supabase's newer `sb_secret_...` keys (step 8, the one that can block launch).
3. A real browser on the staff screens.
4. The cron, Resend and Paystack TEST mode wired up for real.

Never paste a key or a password into a chat, an issue or a commit. Keep them in the host's environment settings.

## 1. Before you start

```bash
npm ci && npm run typecheck && npm test && npm run build
npm run db:test      # needs PostgreSQL 16 server binaries; ends with ALL TESTS PASSED
npm run e2e          # ends with E2E PASSED
```

Push, and wait for CI to be green. Staging is created from the same commit.

## 2. Create the Supabase staging project

Create a new project used for staging only (never reuse it for production; step 12 resets it). Note:

| Value | Where | Goes to |
| --- | --- | --- |
| Project URL | Settings, API | `NEXT_PUBLIC_SUPABASE_URL` |
| Publishable key (`sb_publishable_...`) or the legacy `anon` key | Settings, API Keys | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| Secret key (`sb_secret_...`) | Settings, API Keys | `SUPABASE_SERVICE_ROLE_KEY` (step 8 decides if this is right) |
| Legacy `service_role` key, if the project still shows one | Settings, API Keys | keep aside as the fallback for step 8 |
| Project ref and database password | Settings, General and Database | the CLI in step 3 |

Authentication settings:

- URL Configuration: set Site URL to the staging address, and add `https://<staging-host>/auth/callback` to the
  redirect URLs. Invites and password resets send people there.
- Turn off "Allow new users to sign up". Staff are created by invitation, and guests never have accounts.
  Check afterwards that inviting a person from Staff and permissions still works; if it does not, say so here before
  going further.
- The built-in email sender is for trying things out and is heavily limited. For the invite and reset emails, set a
  custom SMTP sender (Resend can do this) before testing step 10.

## 3. Apply the migrations

With the Supabase CLI (installed and logged in):

```bash
supabase link --project-ref <ref>
supabase db push
supabase migration list     # expect 30 rows, each present locally and remotely
```

Do not apply anything from `supabase/tests/` to a real project: `00_stub_auth.sql` is a local stand-in for Supabase's
auth schema, and `01_seed.sql` is test data.

## 4. Check the security setup

Run these five in the SQL editor. The expected results were produced by applying all 48 migrations to a scratch
PostgreSQL with the same default privileges Supabase uses.

```sql
-- 4a. Tables in public without row-level security. Expect: no rows.
select c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
 order by 1;

-- 4b. Policies that name anon or public. Expect: no rows.
select tablename, policyname, roles
  from pg_policies
 where schemaname = 'public' and (roles::text like '%anon%' or roles::text like '%public%')
 order by 1;

-- 4c. Functions anon can run (leaving out extension and trigger functions).
-- Expect exactly three: has_permission, has_tenant_permission, my_tenant_ids.
-- They read the caller's own id, so for anon they answer false or nothing.
select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prorettype <> 'trigger'::regtype
   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
   and has_function_privilege('anon', p.oid, 'execute')
 order by 1;

-- 4d. The server-only functions must be closed to both client roles. Expect: no rows.
select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('claim_room', 'create_hold', 'confirm_payment', 'search_availability', 'expire_lapsed_holds', 'is_system_caller')
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
```

-- 4e. Views anon can read. Expect: no rows. (Views are not covered by 4a; the two room board views are for
-- authenticated only.)
select c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('v', 'm')
   and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('public', c.oid, 'select'))
 order by 1;
```

Anything different from the expected result is a stop: Supabase grants execute on new functions to `anon` and
`authenticated` by default, and a function whose `revoke` missed one of them is open to the public API.

## 5. Create the first hotel

There is no onboarding screen yet (Phase 7), so the first hotel is created in SQL.

1. Authentication, Users, Add user: create the owner's login with a password and confirm the email. Copy the user's id.
2. Pick the staging address the guest site will answer on (for example `book.staging.example`). It must match the host
   the app is served on, because guest pages find the hotel by host.
3. Run this in the SQL editor, replacing the six placeholders:

```sql
with t as (
  insert into tenants (name, slug) values ('<Hotel name>', '<hotel-slug>') returning id
), p as (
  insert into properties (tenant_id, name, code, city, state)
  select id, '<Property name>', '<CODE>', 'Ibadan', 'Oyo' from t returning id, tenant_id
), d as (
  insert into tenant_domains (tenant_id, property_id, host, is_primary, verified_at)
  select tenant_id, id, '<staging-host>', true, now() from p
), a as (
  insert into payment_provider_accounts (tenant_id, provider, mode, account_label, secret_reference, status)
  select id, 'paystack', 'test', 'Staging', 'env:PAYSTACK_SECRET_STAGING', 'active' from t
), m as (
  insert into tenant_memberships (tenant_id, user_id, status)
  select id, '<owner-user-id>', 'active' from t returning id
)
insert into membership_roles (membership_id, role_id)
select m.id, r.id from m, roles r where r.key = 'owner';
```

Then read the Paystack account id, which step 9 uses in the webhook URL:

```sql
select id from payment_provider_accounts where account_label = 'Staging';
```

`<CODE>` is 2 to 12 capitals, digits or dashes and cannot be changed later. The timezone defaults to `Africa/Lagos`
and the currency to `NGN`.

## 6. Deploy the app

Deploy this commit to the staging host and set these variables there (see `.env.example`):

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | from step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | the secret key from step 2 (server only) |
| `BOOKING_TOKEN_SECRET` | `openssl rand -base64 48` |
| `CRON_SECRET` | `openssl rand -base64 48` |
| `PAYSTACK_SECRET_STAGING` | the Paystack TEST secret key (the name must match `secret_reference` from step 5) |
| `RESEND_API_KEY`, `EMAIL_FROM` | step 9; until then mail waits in the outbox and nothing is lost |

Leave these unset: `PAYSTACK_API_BASE_URL`, `RESEND_API_BASE_URL`, `EMAIL_TRANSPORT`, `EMAIL_LINK_SCHEME` (test-only).

The app must sit behind something that sets `X-Forwarded-For` and `X-Forwarded-Host` (Vercel, Cloudflare, a load
balancer). Without it the per-address rate limits can be dodged and host-based hotel lookup fails.

## 7. Staff sign-in, in a real browser

This is the first check of the real Supabase sign-in. Open `https://<staging-host>/login`.

- Signing in as the owner reaches the dashboard. A wrong password gives the plain error. Signing out returns to login.
- Open `/app` signed out: you are sent to login and back to the page afterwards.
- Staff and permissions, Invite: add a second person (use a real inbox you control) as Front desk. The invite email
  arrives, the link lands on set-a-password, and that person can sign in and sees fewer screens than the owner.
- "Forgot password" sends an email that works.

## 8. The `sb_secret_` check (can block launch)

`is_system_caller()` accepts a call as "the server" when there is no signed-in user and the request's role claim is
`service_role`. Supabase's newer secret keys are not JWTs. Whether the claim still reaches the database with that key
is the question. First create a room type, some rooms and a price (step 11 does this through the screens), then:

```bash
URL=https://<ref>.supabase.co
ANON=<publishable key>
SECRET=<secret key>
BODY='{"p_host":"<staging-host>","p_arrival":"<date 40 days out>","p_departure":"<date 42 days out>","p_adults":2,"p_children":0}'

# 8a. anon can read nothing. Expect: []
curl -s "$URL/rest/v1/tenants" -H "apikey: $ANON"

# 8b. anon cannot call a server-only function. Expect: 401 or 403 and "permission denied"
curl -s -i -X POST "$URL/rest/v1/rpc/search_availability" -H "apikey: $ANON" -H "content-type: application/json" -d "$BODY"

# 8c. the secret key can. Expect: 200 and a JSON list of room types with prices
curl -s -i -X POST "$URL/rest/v1/rpc/search_availability" -H "apikey: $SECRET" -H "content-type: application/json" -d "$BODY"
```

Send the secret key in the `apikey` header only, as shown.

The check that counts is the app itself: on the staging site, search, reserve and pay (step 10). `create_hold` and
`confirm_payment` run with the key in `SUPABASE_SERVICE_ROLE_KEY`.

- Works: record "sb_secret works" in HANDOFF and remove the warning there.
- Refused (the site shows an error, Postgres logs show `is_system_caller` false or a permission error): switch
  `SUPABASE_SERVICE_ROLE_KEY` to the legacy `service_role` key, repeat, and check Supabase's current guidance on how
  long legacy keys stay available. Or change `is_system_caller()` to match what the project really sends. That is a
  migration with a test, so do not edit it on staging by hand.

## 9. Cron, Resend and Paystack

**Cron.** `/api/cron/maintenance` expires unpaid holds, sends due emails, and cleans old rows. Call it every few
minutes with the bearer token:

```bash
curl -s -X POST "https://<staging-host>/api/cron/maintenance" -H "authorization: Bearer $CRON_SECRET"
```

Expect JSON in which each task reports `ok: true`; the same call without the header returns 401. Then schedule it
with whatever the host offers (Vercel Cron, a Supabase `pg_cron` plus `pg_net` job, or an external scheduler such as
a GitHub Actions schedule). Check the host's current limits on how often a job may run before relying on it, since
holds need it every few minutes. Confirm a run happens on its own by looking at the host's logs for
`[maintenance]` lines.

**Resend.** Verify the sending domain in Resend, set `RESEND_API_KEY` and `EMAIL_FROM` (an address on that domain,
for example `"Hotel <bookings@yourdomain>"`), redeploy. Mail that piled up in the outbox is sent by the next cron run.
Bounces and complaints are not handled yet.

**Paystack (TEST mode).** In the Paystack dashboard, TEST mode, set the webhook URL to
`https://<staging-host>/api/webhooks/paystack/<paystack_account_id>` (the id from step 5). Paystack signs each
call with the secret key, and the app rejects anything with a wrong signature.

## 10. The guest flow on staging

Using the Paystack test card from Paystack's documentation:

- Search, reserve and pay. The booking page moves from "confirming your payment" to confirmed. The confirmation email arrives with a working link.
- The staff reservation page shows the booking as confirmed and paid.
- Cancel it from the staff page. A refund is requested, approve it, start the payout in TEST mode, and the guest gets the cancellation and refund emails.
- Leave one hold unpaid and wait past the hold time. After the next cron run it shows as expired and the room is free again.
- Replay the same webhook from the Paystack dashboard: nothing changes and nothing is paid twice.

Also try the bank-details path on a refund once in TEST mode. That path is still unchecked against Paystack's real
responses (see TODO).

## 11. Staff screens, in a real browser

Signed in as the owner, go through Settings once, in this order, as a person setting up a hotel would:

1. Rooms: add a room type and a few rooms.
2. Rates: create the standard rate plan, set a standard price and a couple of nightly prices.
3. Tax rules: add VAT at 7.5 percent from today. Search the guest site and see the tax in the price. Switch the rule
   off and see it disappear. Check that a booking made earlier keeps its tax.
4. Setup history: every change above appears with your name, the old and new values, and the right unit (7.5%, naira).
5. Staff: suspend the invited person, see them lose access, reinstate them, and see both changes in the setup history.

Write down anything that looks wrong, confusing or slow on a phone as well as a laptop.

## 12. Record the result and reset

Add to HANDOFF.md: the date, the commit, what passed, what failed, and the `sb_secret_` decision. Tick the matching
TODO items.

Staging is disposable. To start again, reset the database from the project's dashboard (or `supabase db reset --linked`,
which erases everything in the linked project, so run it only against staging), then repeat from step 3.

## Go or no-go for putting a real hotel on it

All of these should be a clear yes: 4a to 4d match; 8 settled; 7 and 10 passed in a real browser; cron runs by itself;
emails arrive from the real domain; a paid booking confirms through the real webhook; a refund completes in TEST mode.
