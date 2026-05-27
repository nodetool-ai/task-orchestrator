"use server";

import { signIn } from "@/auth";
import { verifyMagicToken } from "@/lib/magic-link";

export async function doMagicSignIn(token: string) {
  const email = await verifyMagicToken(token);
  if (!email) {
    return { error: "This login link has expired or is invalid." };
  }

  try {
    await signIn("credentials", {
      email,
      token,
      redirectTo: "/",
    });
    return { ok: true };
  } catch (err: any) {
    // NextAuth throws on redirect — that's success
    if (err?.message?.includes("NEXT_REDIRECT") || err?.message?.includes("redirect")) {
      return { ok: true };
    }
    return { error: "Sign in failed." };
  }
}
