import Link from "next/link";
import { LayoutDashboard, ListTodo, Target, Activity, FolderGit2, MessageCircle, Users, KeyRound } from "lucide-react";
import { auth } from "@/auth";
import { SignOutButton } from "./sign-out-button";
import { MobileNav } from "./mobile-nav";

const nav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/plans", label: "Plans", icon: Target },
  { href: "/repositories", label: "Repos", icon: FolderGit2 },
  { href: "/runs", label: "Runs", icon: Activity },
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "/personas", label: "Personas", icon: Users },
  { href: "/tokens", label: "Tokens", icon: KeyRound },
];

export async function SiteHeader() {
  const session = await auth();
  const email = session?.user?.email;

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="container flex h-12 items-center gap-1">
        <Link href="/" className="mr-2 flex items-center gap-2 shrink-0">
          <span className="size-4 rounded-sm bg-foreground" />
          <span className="text-sm font-semibold tracking-tight">Task Orchestrator</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              <item.icon className="size-3.5" />
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {/* Desktop: show email + sign-out */}
          {email && (
            <>
              <span className="hidden sm:inline font-mono">{email}</span>
              <SignOutButton />
            </>
          )}
          {/* Mobile: hamburger */}
          <MobileNav email={email ?? undefined} />
        </div>
      </div>
    </header>
  );
}
