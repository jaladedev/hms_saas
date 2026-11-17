"use server";

import { redirect } from "next/navigation";
import { parseContactForm } from "@/lib/guest-site/contact";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { requestHost, sendContactMessage } from "@/lib/guest-site/server";

/** Sends the guest's message to the hotel's inbox and goes back to the contact page. Nothing is emailed from here. */
export async function sendContactAction(formData: FormData): Promise<void> {
  const form = parseContactForm(Object.fromEntries(formData.entries()));
  if (!form.ok) redirect(`/contact?error=${form.error}`);

  const limit = await checkGuestLimits({ ip: ["contactMessage"] });
  if (!limit.allowed) redirect("/contact?error=rate_limited");

  const result = await sendContactMessage({ host: await requestHost(), ...form.value });
  if (!result.ok) redirect(`/contact?error=${result.error.code}`);
  redirect("/contact?sent=1");
}
