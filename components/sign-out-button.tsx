"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="hover:text-foreground transition-colors"
    >
      Sign out
    </button>
  );
}
