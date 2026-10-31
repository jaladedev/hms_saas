/**
 * Turns what a person types into an amount ("12,500.50", "₦12500") into minor units (kobo).
 * Returns null for anything that is not a positive amount with at most two decimals, so a typo
 * is refused rather than guessed at.
 */
export function parseAmountToMinor(input: string): number | null {
  const cleaned = input.replace(/[₦\s,]/g, "");
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const minor = whole * 100 + fraction;
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units to the plain figure used to prefill an input: 1250050 -> "12500.50". */
export function minorToInput(minor: number): string {
  return (minor / 100).toFixed(2);
}
