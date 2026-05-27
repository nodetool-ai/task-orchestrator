import { Suspense } from "react";
import LoginLinkForm from "./login-link-form";
import { verifyMagicToken } from "@/lib/magic-link";

export const dynamic = "force-dynamic";

async function getCsrfToken(): Promise<string> {
  const res = await fetch("http://localhost:3000/api/auth/csrf", {
    cache: "no-store",
  });
  const data = await res.json();
  return data.csrfToken || "";
}

export default async function LoginLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
        <p className="text-sm text-red-400">No login token provided.</p>
        <a href="/login" className="text-sm text-primary hover:underline">
          Go to login
        </a>
      </div>
    );
  }

  const email = await verifyMagicToken(token);
  if (!email) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
        <p className="text-sm text-red-400">This login link has expired or is invalid.</p>
        <a href="/login" className="text-sm text-primary hover:underline">
          Go to login
        </a>
      </div>
    );
  }

  const csrfToken = await getCsrfToken();

  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      }
    >
      <LoginLinkForm token={token} email={email} csrfToken={csrfToken} />
    </Suspense>
  );
}
