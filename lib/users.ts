import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { DEV_USER_EMAIL } from "@/lib/auth-mode";

const BCRYPT_ROUNDS = 10;

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export async function createUser(email: string, password: string): Promise<User> {
  const e = normalize(email);
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new Error(`Invalid email: ${email}`);
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const [row] = await db
    .insert(users)
    .values({ email: e, passwordHash })
    .returning();
  return row;
}

export async function setPassword(email: string, password: string): Promise<void> {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const res = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.email, normalize(email)));
  if (res.count === 0) throw new Error(`No user with email ${email}`);
}

export async function deleteUser(email: string): Promise<boolean> {
  const res = await db.delete(users).where(eq(users.email, normalize(email)));
  return res.count > 0;
}

export async function listUsers(): Promise<User[]> {
  return await db.select().from(users);
}

export async function findUser(email: string): Promise<User | undefined> {
  return (await db.select().from(users).where(eq(users.email, normalize(email))))[0];
}

export async function getUserById(id: number): Promise<User | undefined> {
  return (await db.select().from(users).where(eq(users.id, id)))[0];
}

// Find-or-create the local dev user used when auth is disabled in development
// (see lib/auth-mode). Idempotent. The password hash is an unusable placeholder
// — this account exists only to satisfy the users.id foreign keys on runs,
// chats and tokens; it is never logged into.
export async function ensureDevUser(): Promise<User> {
  // Atomic find-or-create: insert-then-nothing-on-conflict avoids a race where
  // two concurrent cold-DB callers both miss a prior lookup and the second
  // insert throws on the unique email column.
  const [inserted] = await db
    .insert(users)
    .values({ email: DEV_USER_EMAIL, passwordHash: "!dev-no-login" })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  // Row already existed (we lost the insert race): re-select it.
  const existing = await findUser(DEV_USER_EMAIL);
  if (!existing) throw new Error("ensureDevUser: dev user missing after upsert");
  return existing;
}

export async function verifyCredentials(
  email: string,
  password: string
): Promise<User | null> {
  const user = await findUser(email);
  if (!user) {
    // Run a dummy compare to keep timing roughly constant.
    await bcrypt.compare(password, "$2a$10$" + "x".repeat(53));
    return null;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}
