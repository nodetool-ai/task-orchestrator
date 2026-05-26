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
  } catch {
    return { error: "Sign in failed." };
  }
}
