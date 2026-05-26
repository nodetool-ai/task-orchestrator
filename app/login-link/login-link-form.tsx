"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { doMagicSignIn } from "./actions";

export default function LoginLinkForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    doMagicSignIn(token).then((res) => {
      if (res.error) {
        setError(res.error);
      }
      // If successful, signIn will redirect
    });
  }, [token]);

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
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Signing you in...</p>
    </div>
  );
}
