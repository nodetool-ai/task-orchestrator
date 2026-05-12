import type { NextAuthConfig } from "next-auth";

// Edge-safe config: no DB, no Node built-ins. Used by middleware to read
// the JWT session cookie. The full config (auth.ts) layers the Credentials
// provider on top and runs only in the Node runtime.
export const authConfig: NextAuthConfig = {
  providers: [],
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
};
