/**
 * Currencies a hotel can use (migration 163): the ones Paystack settles, with the Paystack country each bank list is asked for.
 * One currency per hotel; nothing converts between currencies inside a money function.
 */
export const SUPPORTED_CURRENCIES = ["NGN", "GHS", "KES", "ZAR", "USD"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
export const CURRENCY_LABEL: Record<SupportedCurrency, string> = {
  NGN: "Nigerian naira (NGN)",
  GHS: "Ghanaian cedi (GHS)",
  KES: "Kenyan shilling (KES)",
  ZAR: "South African rand (ZAR)",
  USD: "US dollar (USD)",
};
export const PAYSTACK_COUNTRY: Record<SupportedCurrency, string | null> = {
  NGN: "nigeria",
  GHS: "ghana",
  KES: "kenya",
  ZAR: "south africa",
  USD: null,
};

export const isSupportedCurrency = (c: string): c is SupportedCurrency => (SUPPORTED_CURRENCIES as readonly string[]).includes(c);
