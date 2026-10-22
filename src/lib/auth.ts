import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { db } from "./db";

export const SESSION_COOKIE = "crm_session";
const SESSION_DAYS = 30;

// A bcrypt hash of a random string, compared when the e-mail has no account
const NO_ACCOUNT = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8.5RvZp0GzGm7RkqlY7VnFz6oXKq7u";

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

// Five wrong passwords for one e-mail lock it for 15 minutes, so nobody can try passwords by the thousand
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

/** The user, null for a wrong e-mail or password, or "locked" after too many tries. */
export async function login(email: string, password: string) {
  const address = email.toLowerCase().trim().slice(0, 200);
  const key = `login_fails:${address}`;
  const fails = (await db.setting.findUnique({ where: { key } }))?.value as { count: number; at: string } | undefined;
  const recent = fails?.count && Date.now() - new Date(fails.at).getTime() < LOCK_MS ? fails.count : 0;
  if (recent >= MAX_FAILS) return "locked" as const;
  const user = await db.user.findUnique({ where: { email: address } });
  // The same bcrypt work with or without an account, so the answer's time never tells which e-mails are the team's
  const ok = await bcrypt.compare(password, user?.passwordHash ?? NO_ACCOUNT);
  if (!user || !ok) {
    // Counted for any e-mail typed, an account or not, so the lock doesn't tell either
    const value = { count: recent + 1, at: new Date().toISOString() };
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    return null;
  }
  if (fails) await db.setting.deleteMany({ where: { key } });
  const id = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.session.create({ data: { id, userId: user.id, expiresAt } });
  const store = await cookies();
  store.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
  return user;
}

export async function logout() {
  const store = await cookies();
  const id = store.get(SESSION_COOKIE)?.value;
  if (id) await db.session.deleteMany({ where: { id } });
  store.delete(SESSION_COOKIE);
}

export async function currentUser() {
  const store = await cookies();
  const id = store.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  // Reading the clock is only allowed once the render is marked as per-request
  await connection();
  // One query (an include would take two): the user of this session, while it has not expired
  return db.user.findFirst({ where: { sessions: { some: { id, expiresAt: { gt: new Date() } } } } });
}

export async function requireUser() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** "Bearer <secret>" in the header, compared in constant time so the answer's timing gives nothing away. */
export function bearerMatches(header: string | null, secret: string | undefined) {
  if (!secret || !header) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
