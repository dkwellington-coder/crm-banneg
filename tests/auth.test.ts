// Login against a real Postgres. Runs only when TEST_DATABASE_URL is set.
import { describe, expect, it, vi } from "vitest";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;

vi.mock("next/headers", () => ({ cookies: async () => ({ set() {}, get() {}, delete() {} }) }));

describe.skipIf(!dbUrl)("login", () => {
  it("locks an e-mail after five wrong passwords, and lets the right one in once the 15 minutes pass", async () => {
    const { db } = await import("@/lib/db");
    const { login, hashPassword } = await import("@/lib/auth");
    await db.$executeRawUnsafe('TRUNCATE "Session","User","Setting" CASCADE');
    await db.user.create({ data: { name: "Ana", email: "ana@exemplo.com", role: "OWNER", passwordHash: await hashPassword("certa123") } });

    for (let i = 0; i < 5; i++) expect(await login("ana@exemplo.com", "errada")).toBeNull();
    expect(await login("ana@exemplo.com", "certa123")).toBe("locked");
    // An e-mail with no account gets the same answers, so the lock tells nothing
    for (let i = 0; i < 5; i++) expect(await login("ninguem@exemplo.com", "x")).toBeNull();
    expect(await login("ninguem@exemplo.com", "x")).toBe("locked");

    const key = "login_fails:ana@exemplo.com";
    await db.setting.update({ where: { key }, data: { value: { count: 5, at: new Date(Date.now() - 16 * 60_000).toISOString() } } });
    expect(await login(" Ana@Exemplo.com", "certa123")).toMatchObject({ email: "ana@exemplo.com" });
    expect(await db.setting.findUnique({ where: { key } })).toBeNull();
    expect(await db.session.count()).toBe(1);
  });
});
