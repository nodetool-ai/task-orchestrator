"use client";

import { useEffect, useRef, useState } from "react";

export default function LoginLinkForm({
  token,
  email,
}: {
  token: string;
  email: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [csrfToken, setCsrfToken] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/csrf", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.csrfToken) {
          setCsrfToken(data.csrfToken);
        } else {
          setError("Failed to get CSRF token.");
        }
      })
      .catch(() => setError("Failed to get CSRF token."));
  }, []);

  useEffect(() => {
    if (csrfToken && formRef.current) {
      formRef.current.submit();
    }
  }, [csrfToken]);

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

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <p className="text-sm text-muted-foreground">Signing you in...</p>
      <form
        ref={formRef}
        method="post"
        action="/api/auth/callback/credentials"
        className="hidden"
      >
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="callbackUrl" value="/" />
      </form>
    </div>
  );
}
