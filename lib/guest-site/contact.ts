import { guestSchema } from "@/lib/guest-site/params";

export const MESSAGE_MAX = 2000;
export const MESSAGE_MIN = 5;

export type ContactInput = { name: string; email: string; message: string };

/**
 * Reads the contact form: name, email and a message of 5 to 2000 characters. Line breaks are kept, runs of blank lines are
 * squeezed to one, and the email is lowercased. Anything else is refused with the one error code the page shows.
 */
export function parseContactForm(
  raw: Record<string, unknown>,
): { ok: true; value: ContactInput } | { ok: false; error: "contact_details" } {
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const guest = guestSchema.pick({ full_name: true, email: true }).safeParse({ full_name: str("name"), email: str("email") });
  const message = str("message")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!guest.success || message.length < MESSAGE_MIN || message.length > MESSAGE_MAX) return { ok: false, error: "contact_details" };
  return { ok: true, value: { name: guest.data.full_name, email: guest.data.email, message } };
}
