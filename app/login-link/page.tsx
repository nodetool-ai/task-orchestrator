"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";

export default function LoginLinkPage() {
  return (
    <Suspense fallback={<Loading message="Loading..." />}>
      <LoginLinkHandler />
    </Suspense>
  );
}

function Loading({ message }: { message: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function LoginLinkHandler() {
  const sp = useSearchParams();
  const router = useRouter();
  const token = sp.get("token");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError("No login token provided.");
      return;
    }

    // Decode token to get email (JWT payload is base64url, safe to read client-side)
    let email: string | null = null;
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      email = payload.email ?? null;
    } catch {
      setError("Invalid login link.");
      return;
    }

    if (!email) {
      setError("Invalid login link.");
      return;
    }

    signIn("magic-link", { email, token, redirect: false })
      .then((res) => {
        if (!res || res.error) {
          setError("This login link has expired or is invalid.");
          return;
        }
        router.push("/");
        router.refresh();
      })
      .catch(() => setError("Something went wrong. Please try again."));
  }, [token, router]);

  if (error) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
        <p className="text-sm text-red-400">{error}</p>
        <a href="/login" className="text-sm text-primary hover:underline">
          Go to login
        </a>
      </div>
    );
  }

  return <Loading message="Signing you in..." />;
}
