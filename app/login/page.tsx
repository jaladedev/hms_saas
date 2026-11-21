import type { Metadata } from "next";
import Link from "next/link";
import { PasswordField, SubmitButton } from "@/components/staff/login-bits";
import { inputClass } from "@/components/staff/ui";
import { guestHotel, requestHost } from "@/lib/guest-site/server";
import { safeNext, signInErrorMessage, signInNotice } from "@/lib/staff/auth";
import { signIn } from "@/lib/staff/auth-actions";
import { loginBrand } from "@/lib/staff/login-brand";
import { photoUrl } from "@/lib/staff/room-photos";
import { lookStyle, THEME_WRAPPER_CLASS } from "@/lib/theme";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The hotel behind this address, or null (the platform's own address, an unknown host, a failed lookup): the page is then plain. */
async function loadHotel() {
  const result = await guestHotel(await requestHost());
  return result.ok ? result.data : null;
}

export async function generateMetadata(): Promise<Metadata> {
  const brand = loginBrand(await loadHotel());
  return { title: brand ? `Staff sign in · ${brand.name}` : "Staff sign in" };
}

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const error = signInErrorMessage(one(search.err));
  const notice = signInNotice(one(search.ok));
  const next = safeNext(one(search.next));
  const hotel = await loadHotel();
  const brand = loginBrand(hotel);

  return (
    <div
      className={`min-h-screen ${THEME_WRAPPER_CLASS}`}
      style={lookStyle({
        theme: hotel?.theme,
        primary: hotel?.theme_primary,
        fontDisplay: hotel?.font_display,
        fontBody: hotel?.font_body,
        radius: hotel?.radius,
      })}
    >
      <main className="mx-auto max-w-sm px-4 py-24">
        {brand ? (
          <div className="flex items-center gap-3 font-display text-xl">
            {brand.logo ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", brand.logo)}
                  alt={brand.name}
                  className="h-10 max-w-48 object-contain"
                />
              </>
            ) : (
              <>
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary font-sans text-base font-semibold text-white"
                >
                  {brand.mark}
                </span>
                <span>{brand.name}</span>
              </>
            )}
          </div>
        ) : (
          <p className="font-display text-xl text-navy-900">HMS</p>
        )}
        <h1 className="mt-6 font-display text-3xl">Staff sign in</h1>
        <p className="mt-2 text-sm text-muted">Use the email and password your hotel gave you.</p>

        {notice && !error && (
          <p role="status" className="mt-6 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">
            {error}
          </p>
        )}

        <form action={signIn} className="mt-6 space-y-4">
          {next !== "/app" && <input type="hidden" name="next" value={next} />}
          <div>
            <label htmlFor="email" className="block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="username"
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
              className={`${inputClass} mt-1`}
            />
          </div>
          <PasswordField />
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="remember" className="h-4 w-4 accent-primary" />
              Keep me signed in on this device
            </label>
            <p className="mt-1 pl-6 text-xs text-muted">
              Leave this off on a shared computer: you will be signed out when the browser closes.
            </p>
          </div>
          <SubmitButton>Sign in</SubmitButton>
        </form>
        <p className="mt-4 text-sm">
          <Link href="/forgot-password" className="text-primary-strong underline underline-offset-2">
            Forgot your password?
          </Link>
        </p>
      </main>
    </div>
  );
}
