"use client";

import { Suspense, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const sp = useSearchParams();
  const router = useRouter();
  const next = sp.get("next") || "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(sp.get("error"));
  const [pending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (!res || res.error) {
        setError("Invalid email or password.");
        return;
      }
      router.push(next);
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-sm pt-20 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Access is restricted to the team.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="email" className="text-xs font-medium text-muted-foreground">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-foreground"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-foreground"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className={cn(
          "inline-flex w-full items-center justify-center gap-2 rounded-md bg-foreground text-background px-3 py-2 text-sm font-medium",
          "hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        )}
      >
        {pending && <Loader2 className="size-3.5 animate-spin" />}
        Sign in
      </button>

      {error && (
        <p className="text-xs text-state-blocked">{error}</p>
      )}
    </form>
  );
}
