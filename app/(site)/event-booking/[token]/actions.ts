"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { startEventCheckout } from "@/lib/guest-site/event-checkout";
import { eventTokenId } from "@/lib/guest-site/server";

const schema = z.object({ token: z.string().min(10).max(512), key: z.string().min(8).max(100) });

/** Pays the deposit (while the hold lasts) or the balance (once confirmed) for the booking behind the signed link. */
export async function payBookingAction(formData: FormData): Promise<void> {
  const input = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!input.success) redirect("/venues?error=bad_request");
  const id = eventTokenId(input.data.token, "v");
  if (!id) redirect("/venues?error=bad_request");
  await startEventCheckout("booking", id, `/event-booking/${input.data.token}`, input.data.key);
}
