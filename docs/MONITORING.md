# Monitoring (System Design 9.5)

`GET /api/health` answers "is anything wrong that a person should know about?". It reads counts from the database function
`ops_health()` (migration 094) and judges them in `lib/ops-health.ts`. It returns counts and check names only, never guest data.

## Calling it

```
curl -s https://<host>/api/health -H "authorization: Bearer $CRON_SECRET"
```

| Answer | Meaning |
| --- | --- |
| 200, `status: "ok"` | nothing to report |
| 200, `status: "warn"` | worth a look today; the body lists the issues |
| 503, `status: "fail"` | a person is needed now, or the maintenance job has stopped, or the database could not be read |
| 401 | missing or wrong secret |

Point an uptime monitor at it that can send a header (Better Stack, UptimeRobot Pro, Checkly, a Vercel/GitHub scheduled check) and
alert on any non-200. A monitor that cannot send a header cannot use this endpoint; do not weaken the secret for it.

## Checks and thresholds

| Check | Level | Meaning | What to do |
| --- | --- | --- | --- |
| `maintenance` | fail | no good run of `/api/cron/maintenance` in 30 minutes, or it never ran | check the scheduler and `CRON_SECRET`; run the cron URL by hand and read the response |
| `maintenance` | warn | the latest run had a failed step | read the response of the next run; the error text is in the issue |
| `paid_inventory_lost` | fail | a guest paid for a room that was no longer free | the booking shows "Needs attention"; move the guest to another room or refund |
| `payment_events_stuck` | fail | a Paystack notice was received 10+ minutes ago and not processed | money may not be applied; use Payments to verify, and check the webhook logs |
| `refunds_stuck` | fail | a refund has been "processing" for over 2 hours | the payout outcome is unknown; check Paystack before retrying (the provider is called once per refund) |
| `holds_overdue` | fail | a held room is still held 15+ minutes after the hold ended | the maintenance job releases these; if it is running, report it as a bug |
| `emails_stuck` | warn | an email is 30+ minutes past due | check the email provider key and `/app/emails` |
| `emails_failed_7d` | warn | 5 or more emails gave up in 7 days | same |
| `payment_events_mismatch_7d` | warn | a Paystack notice matched no payment attempt | compare with the Paystack dashboard |
| `attention_other` | warn | open bookings flagged for attention (for example a refund due after a change) | work the "Needs attention" list |

Thresholds are constants in `lib/ops-health.ts`; the time windows inside the counts are in migration 094.

## How the heartbeat works

The maintenance route calls `record_heartbeat('maintenance', ok, error)` after each run. A failed step stores its error and keeps
the last good time. A job that stops running leaves an old row, so it is caught by age, which is the only way to see a silent stop.
Both functions and the `ops_heartbeats` table are service role only.

## Not done yet

- The scheduler and the monitor are not wired on staging (needs the staging project and a monitor account).
- No alert channel is chosen (email, SMS, Slack). The monitor's own alerting is the plan.
- Errors thrown inside the app are not collected (an error tracker such as Sentry is a separate choice).
