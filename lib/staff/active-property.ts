import "server-only";
import { cookies } from "next/headers";
import { ACTIVE_PROPERTY_COOKIE, isPropertyId } from "./property-choice";

/** The property the person picked in the header, or undefined. A hint only: pages check it against what the person can see. */
export async function rememberedProperty(): Promise<string | undefined> {
  const v = (await cookies()).get(ACTIVE_PROPERTY_COOKIE)?.value;
  return isPropertyId(v) ? v : undefined;
}
