"use client";

import { useEffect, useRef } from "react";

export default function LoginLinkForm({
  token,
  email,
  csrfToken,
}: {
  token: string;
  email: string;
  csrfToken: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    formRef.current?.submit();
  }, []);

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
