import { Suspense } from "react";
import LoginLinkForm from "./login-link-form";

export const dynamic = "force-dynamic";

function FormWrapper({ token }: { token: string }) {
  return <LoginLinkForm token={token} />;
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

  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      }
    >
      <FormWrapper token={token} />
    </Suspense>
  );
}
