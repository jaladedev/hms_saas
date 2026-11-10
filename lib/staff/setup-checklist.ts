/**
 * The setup checklist on the Settings page: what a new hotel still needs before it can take bookings, worked out
 * from what is already saved, so progress is never stored separately and can never go out of step with the hotel.
 * Pure functions, so they can be tested. Three steps are required (a booking cannot be made without them); the
 * other two are recommended, because the database has safe defaults for them (no tax, full payment online, free
 * cancellation) that a hotel should still choose on purpose.
 */

export type SetupCounts = {
  /** Room types switched on. */
  roomTypes: number;
  /** Rooms that are not retired. */
  rooms: number;
  /** An active default rate plan exists. */
  hasDefaultRatePlan: boolean;
  taxRules: number;
  policyVersions: number;
};

export type SetupStep = {
  key: "room_types" | "rooms" | "rates" | "tax" | "policies";
  title: string;
  text: string;
  href: string;
  required: boolean;
  done: boolean;
};

export function buildChecklist(c: SetupCounts): SetupStep[] {
  return [
    {
      key: "room_types",
      title: "Add a room type",
      text: "The kinds of room you sell, their capacity and standard price.",
      href: "/app/settings/rooms",
      required: true,
      done: c.roomTypes > 0,
    },
    {
      key: "rooms",
      title: "Add your rooms",
      text: "The physical rooms under each type. Guests can only book a type that has a room.",
      href: "/app/settings/rooms",
      required: true,
      done: c.rooms > 0,
    },
    {
      key: "rates",
      title: "Create the standard rate plan",
      text: "Without it no price can be worked out and nothing can be booked.",
      href: "/app/settings/rates",
      required: true,
      done: c.hasDefaultRatePlan,
    },
    {
      key: "tax",
      title: "Set up tax rules",
      text: "Until you add one, no tax is added to nights or extras.",
      href: "/app/settings/tax",
      required: false,
      done: c.taxRules > 0,
    },
    {
      key: "policies",
      title: "Choose payment and cancellation policies",
      text: "Until you publish one, guests pay in full online and can cancel for free.",
      href: "/app/settings/policies",
      required: false,
      done: c.policyVersions > 0,
    },
  ];
}

export type Progress = { done: number; total: number; ready: boolean; complete: boolean; next: SetupStep | null };

/** `ready`: every required step is done, so the hotel can take a booking. `complete`: every step is done. `next`: the first step left, required ones first. */
export function progressOf(steps: SetupStep[]): Progress {
  const left = steps.filter((s) => !s.done);
  const next = left.find((s) => s.required) ?? left[0] ?? null;
  return {
    done: steps.length - left.length,
    total: steps.length,
    ready: steps.filter((s) => s.required).every((s) => s.done),
    complete: left.length === 0,
    next,
  };
}

type Row = { property_id: string };

/** Counts for one property from rows already read (each list is the visible rows of its table). Rows of other properties are ignored. */
export function countsFor(
  propertyId: string,
  data: {
    roomTypes: (Row & { status: string })[];
    rooms: (Row & { operational_status: string })[];
    ratePlans: (Row & { is_default: boolean; status: string })[];
    taxRules: Row[];
    policies: Row[];
  },
): SetupCounts {
  const mine = <T extends Row>(rows: T[]) => rows.filter((r) => r.property_id === propertyId);
  return {
    roomTypes: mine(data.roomTypes).filter((r) => r.status === "active").length,
    rooms: mine(data.rooms).filter((r) => r.operational_status !== "retired").length,
    hasDefaultRatePlan: mine(data.ratePlans).some((r) => r.is_default && r.status === "active"),
    taxRules: mine(data.taxRules).length,
    policyVersions: mine(data.policies).length,
  };
}
