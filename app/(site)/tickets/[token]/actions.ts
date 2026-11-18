"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { startEventCheckout } from "@/lib/guest-site/event-checkout";
import { eventTokenId } from "@/lib/guest-site/server";

const schema = z.object({ token: z.string().min(10).max(512), key: z.string().min(8).max(100) });

/** Pays for the ticket order behind the signed link while its 20-minute hold lasts. */
export async function payTicketsAction(formData: FormData): Promise<void> {
  const input = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!input.success) redirect("/events?error=bad_request");
  const id = eventTokenId(input.data.token, "t");
  if (!id) redirect("/events?error=bad_request");
  await startEventCheckout("ticket_order", id, `/tickets/${input.data.token}`, input.data.key);
}
