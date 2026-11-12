/**
 * "Why can't this hotel take guest bookings?" for platform support: the facts from platform_hotel_readiness (migration 109) turned
 * into plain checks. Pure, so it is tested without a server. Counts and yes/no facts only: it never sees a guest, a payment or a secret.
 * A blocker stops a guest booking; advice is worth doing but does not stop one (the database has safe defaults for tax and policies).
 */

export type ReadinessProperty = {
  id: string;
  name: string;
  status: string;
  room_types: number;
  rooms: number;
  default_rate_plan: boolean;
  tax_rules: number;
  policy_versions: number;
  domains_verified: number;
};

export type Readiness = {
  tenant_status: string;
  online_booking: boolean;
  online_payments: boolean;
  active_payment_accounts: number;
  domains: number;
  domains_verified: number;
  properties: ReadinessProperty[];
};

export type Check = { key: string; label: string; ok: boolean; blocker: boolean; detail: string };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Reads the answer defensively: anything missing or the wrong type becomes the safe "not ready" value. */
export function readReadiness(raw: unknown): Readiness | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const props = Array.isArray(o.properties) ? o.properties : [];
  return {
    tenant_status: str(o.tenant_status),
    online_booking: o.online_booking !== false,
    online_payments: o.online_payments !== false,
    active_payment_accounts: num(o.active_payment_accounts),
    domains: num(o.domains),
    domains_verified: num(o.domains_verified),
    properties: props.map((p) => {
      const r = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      return {
        id: str(r.id),
        name: str(r.name),
        status: str(r.status),
        room_types: num(r.room_types),
        rooms: num(r.rooms),
        default_rate_plan: r.default_rate_plan === true,
        tax_rules: num(r.tax_rules),
        policy_versions: num(r.policy_versions),
        domains_verified: num(r.domains_verified),
      };
    }),
  };
}

/** The checks that apply to the whole hotel group. */
export function groupChecks(r: Readiness): Check[] {
  return [
    {
      key: "tenant_active",
      label: "The hotel group is active",
      ok: r.tenant_status === "active",
      blocker: true,
      detail:
        r.tenant_status === "active" ? "Active." : `Status is "${r.tenant_status || "unknown"}", so its website and staff area are closed.`,
    },
    {
      key: "domain",
      label: "A verified website address",
      ok: r.domains_verified > 0,
      blocker: true,
      detail:
        r.domains_verified > 0
          ? `${r.domains_verified} of ${r.domains} verified.`
          : r.domains > 0
            ? `${r.domains} added, none verified yet: guests cannot reach the site.`
            : "No website address added.",
    },
    {
      key: "online_booking",
      label: "Online booking is switched on",
      ok: r.online_booking,
      blocker: true,
      detail: r.online_booking ? "The online_booking flag is on." : "The online_booking flag is off: the website takes no new bookings.",
    },
    {
      key: "online_payments",
      label: "Card payments are switched on",
      ok: r.online_payments,
      blocker: false,
      detail: r.online_payments
        ? "The online_payments flag is on."
        : "The online_payments flag is off: guests cannot start a card payment.",
    },
    {
      key: "payment_account",
      label: "An active payment account",
      ok: r.active_payment_accounts > 0,
      blocker: false,
      detail:
        r.active_payment_accounts > 0
          ? `${r.active_payment_accounts} active.`
          : "None is active, so card payments cannot be taken (pay-at-hotel bookings are unaffected).",
    },
  ];
}

/** The checks for one property. */
export function propertyChecks(p: ReadinessProperty): Check[] {
  return [
    {
      key: "status",
      label: "The property is open",
      ok: p.status === "active",
      blocker: true,
      detail: p.status === "active" ? "Active." : `Status is "${p.status || "unknown"}".`,
    },
    {
      key: "room_types",
      label: "A public room type",
      ok: p.room_types > 0,
      blocker: true,
      detail: p.room_types > 0 ? `${p.room_types} on sale.` : "No active public room type.",
    },
    {
      key: "rooms",
      label: "Rooms in use",
      ok: p.rooms > 0,
      blocker: true,
      detail: p.rooms > 0 ? `${p.rooms} rooms.` : "No room that is not retired.",
    },
    {
      key: "rate_plan",
      label: "An active standard rate plan",
      ok: p.default_rate_plan,
      blocker: true,
      detail: p.default_rate_plan ? "Set." : "None, so nothing can be priced.",
    },
    {
      key: "tax",
      label: "Tax rules chosen",
      ok: p.tax_rules > 0,
      blocker: false,
      detail: p.tax_rules > 0 ? `${p.tax_rules} active.` : "None: bookings carry no tax until the hotel chooses.",
    },
    {
      key: "policies",
      label: "Policies chosen",
      ok: p.policy_versions > 0,
      blocker: false,
      detail: p.policy_versions > 0 ? "Saved." : "None saved: the database defaults apply (full payment online, free cancellation).",
    },
  ];
}

/** Every check, and how many blockers fail: a hotel with zero failing blockers can take a guest booking. */
export function summarize(r: Readiness): { group: Check[]; properties: { id: string; name: string; checks: Check[] }[]; blockers: number } {
  const group = groupChecks(r);
  const properties = r.properties.map((p) => ({ id: p.id, name: p.name, checks: propertyChecks(p) }));
  const blockers = [...group, ...properties.flatMap((p) => p.checks)].filter((c) => c.blocker && !c.ok).length;
  return { group, properties, blockers };
}
