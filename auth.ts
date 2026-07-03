import NextAuth, { type Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyCredentials, findUser, ensureDevUser } from "@/lib/users";
import { verifyMagicToken } from "@/lib/magic-link";
import { authConfig } from "./auth.config";
import { isAuthDisabled } from "@/lib/auth-mode";

const nextAuth = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: "Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        token: { label: "Token", type: "text" },
      },
      async authorize(creds) {
        const email = typeof creds?.email === "string" ? creds.email : "";
        const password = typeof creds?.password === "string" ? creds.password : "";
        const token = typeof creds?.token === "string" ? creds.token : "";
        if (!email) return null;

        // Magic link login
        if (token) {
          const verifiedEmail = await verifyMagicToken(token);
          if (!verifiedEmail || verifiedEmail.toLowerCase() !== email.toLowerCase()) return null;
          const user = await findUser(email);
          if (!user) return null;
          return { id: String(user.id), email: user.email };
        }

        // Password login
        if (password) {
          const user = await verifyCredentials(email, password);
          if (!user) return null;
          return { id: String(user.id), email: user.email };
        }

        return null;
      },
    }),
  ],
  callbacks: {
    // Persist the user id on the JWT so server components / API routes can
    // scope queries (e.g. chat history) without a DB lookup.
    jwt({ token, user }) {
      if (user?.id) token.id = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.id && session.user) {
        (session.user as { id?: string }).id = String(token.id);
      }
      return session;
    },
  },
});

export const { handlers, signIn, signOut } = nextAuth;

// In development the login gate is off (see lib/auth-mode). A no-arg
// `await auth()` then returns a synthetic session for the local dev user so
// the layout and every API route see a logged-in user with a real users.id.
// Any other call form (middleware/route-handler wrappers) delegates to the
// real NextAuth handler unchanged.
export const auth = (async (...args: unknown[]) => {
  if (args.length === 0 && isAuthDisabled()) {
    const user = await ensureDevUser();
    const session: Session = {
      user: { id: String(user.id), email: user.email } as Session["user"],
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    return Promise.resolve(session);
  }
  return (nextAuth.auth as (...a: unknown[]) => unknown)(...args);
}) as typeof nextAuth.auth;
