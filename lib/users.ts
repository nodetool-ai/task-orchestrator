import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type User } from "@/db/schema";

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
  const [row] = db
    .insert(users)
    .values({ email: e, passwordHash })
    .returning()
    .all();
  return row;
}

export async function setPassword(email: string, password: string): Promise<void> {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const res = db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.email, normalize(email)))
    .run();
  if (res.changes === 0) throw new Error(`No user with email ${email}`);
}

export function deleteUser(email: string): boolean {
  const res = db.delete(users).where(eq(users.email, normalize(email))).run();
  return res.changes > 0;
}

export function listUsers(): User[] {
  return db.select().from(users).all();
}

export function findUser(email: string): User | undefined {
  return db.select().from(users).where(eq(users.email, normalize(email))).get();
}

export function getUserById(id: number): User | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export async function verifyCredentials(
  email: string,
  password: string
): Promise<User | null> {
  const user = findUser(email);
  if (!user) {
    // Run a dummy compare to keep timing roughly constant.
    await bcrypt.compare(password, "$2a$10$" + "x".repeat(53));
    return null;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}
