import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyCredentials, findUser } from "@/lib/users";
import { verifyMagicToken } from "@/lib/magic-link";
import { authConfig } from "./auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
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
          const user = findUser(email);
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
