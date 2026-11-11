// Acessos: the owner gives each person a login, a password and the screens they can open (Wellington, 2026-11-11).
// Runs against a real Postgres when TEST_DATABASE_URL is set; the screen rules run always.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { areasOf, canSee, cleanAreas, homeOf, LEAD_AREAS } from "@/lib/areas";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;

// The session cookie of whoever is "signed in" in each step
let session: string | undefined;
vi.mock("next/headers", () => ({ cookies: async () => ({ set() {}, delete() {}, get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {}, after() {} }));

describe("screens each person can open", () => {
  it("the owner and '*' open everything; others only what was ticked; nothing ticked lands on 'sem acesso'", () => {
    expect(areasOf({ role: "OWNER", areas: [] })).toHaveLength(8);
    expect(areasOf({ role: "SELLER", areas: ["*"] })).toHaveLength(8);
    const seller = { role: "SELLER", areas: ["agenda", "conversas"] };
    // In the menu's order, whatever order they were saved in
    expect(areasOf(seller)).toEqual(["conversas", "agenda"]);
    expect(canSee(seller, "configuracoes")).toBe(false);
    expect(canSee(seller, LEAD_AREAS)).toBe(true);
    expect(homeOf(seller)).toBe("/conversas");
    expect(homeOf({ role: "SELLER", areas: [] })).toBe("/sem-acesso");
    // What comes from the form: unknown names dropped, all ticked kept as "*" (new screens later come along)
    expect(cleanAreas(["funil", "hack", "agenda"])).toEqual(["funil", "agenda"]);
    expect(cleanAreas(["funil", "conversas", "agenda", "metas", "painel", "simulador", "integracoes", "configuracoes"])).toEqual(["*"]);
  });
});

describe.skipIf(!dbUrl)("Acessos page actions", () => {
  let db: typeof import("@/lib/db").db;
  let auth: typeof import("@/lib/auth");
  let actions: typeof import("@/app/actions");
  let access: typeof import("@/lib/access");

  const signIn = async (userId: string) => {
    session = `s-${userId}`;
    await db.session.create({ data: { id: session, userId, expiresAt: new Date(Date.now() + 86_400_000) } });
  };
  const form = (fields: Record<string, string | string[]>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) f.append(k, one);
    return f;
  };

  beforeEach(async () => {
    db = (await import("@/lib/db")).db;
    auth = await import("@/lib/auth");
    actions = await import("@/app/actions");
    access = await import("@/lib/access");
    session = undefined;
    await db.$executeRawUnsafe('TRUNCATE "Session","User","Setting" CASCADE');
  });

  it("creates a login with a password and chosen screens, which the person can then use and nothing more", async () => {
    const owner = await db.user.create({ data: { name: "Wellington", email: "dono@exemplo.com", role: "OWNER", passwordHash: "x" } });
    // Everyone already there keeps seeing everything
    expect(owner.areas).toEqual(["*"]);
    await signIn(owner.id);

    const created = await actions.saveAccessAction(
      {},
      form({ name: "Paula Souza", email: " Paula@Exemplo.com ", password: "senha-forte-1", role: "SELLER", areas: ["funil", "agenda"] }),
    );
    expect(created).toMatchObject({ ok: true, message: "Acesso criado.", login: { name: "Paula Souza", email: "paula@exemplo.com", password: "senha-forte-1" } });
    const paula = await db.user.findUniqueOrThrow({ where: { email: "paula@exemplo.com" } });
    expect(paula).toMatchObject({ role: "SELLER", areas: ["funil", "agenda"] });
    expect(await auth.login("paula@exemplo.com", "senha-forte-1")).toMatchObject({ id: paula.id });

    // Signed in as Paula: the funnel and a lead's page open, Ajustes sends her back to her first screen
    await signIn(paula.id);
    await expect(access.requireArea("funil")).resolves.toMatchObject({ id: paula.id });
    await expect(access.requireArea(LEAD_AREAS)).resolves.toMatchObject({ id: paula.id });
    await expect(access.requireArea("configuracoes")).rejects.toThrow("REDIRECT /funil");
    await expect(access.requireOwnerPage()).rejects.toThrow("REDIRECT /funil");
    // Nor can she change anyone's access
    await expect(actions.saveAccessAction({}, form({ name: "Paula", email: "paula@exemplo.com", role: "OWNER" }))).rejects.toThrow();
    expect((await db.user.findUniqueOrThrow({ where: { id: paula.id } })).role).toBe("SELLER");
  });

  it("refuses what would leave a bad access, and a new password signs the person out everywhere", async () => {
    const owner = await db.user.create({ data: { name: "Wellington", email: "dono@exemplo.com", role: "OWNER", passwordHash: "x" } });
    await signIn(owner.id);
    const base = { name: "Rui", email: "rui@exemplo.com", role: "MANAGER" };
    expect(await actions.saveAccessAction({}, form({ ...base, password: "senha-forte-1" }))).toEqual({ error: "Marque pelo menos uma tela que a pessoa pode abrir." });
    expect(await actions.saveAccessAction({}, form({ ...base, password: "curta", areas: "funil" }))).toEqual({ error: "A senha precisa ter pelo menos 8 caracteres." });
    expect(await actions.saveAccessAction({}, form({ ...base, email: "rui", password: "senha-forte-1", areas: "funil" }))).toEqual({ error: "O usuário é o e-mail da pessoa, com @." });
    expect(await actions.saveAccessAction({}, form({ ...base, areas: "funil" }))).toEqual({ error: "Dê uma senha para o novo acesso." });
    // The only owner cannot turn into a manager
    expect(await actions.saveAccessAction({}, form({ name: "Wellington", email: "dono@exemplo.com", role: "MANAGER", areas: "funil" }))).toEqual({
      error: "O CRM precisa de pelo menos um proprietário.",
    });
    expect(await db.user.count()).toBe(1);

    // All screens ticked: kept as "*"
    await actions.saveAccessAction({}, form({ ...base, password: "senha-forte-1", areas: ["funil", "conversas", "agenda", "metas", "painel", "simulador", "integracoes", "configuracoes"] }));
    const rui = await db.user.findUniqueOrThrow({ where: { email: "rui@exemplo.com" } });
    expect(rui.areas).toEqual(["*"]);
    await db.session.create({ data: { id: "rui-phone", userId: rui.id, expiresAt: new Date(Date.now() + 86_400_000) } });

    // Fewer screens, same password: he stays signed in, the screens change at once
    expect(await actions.saveAccessAction({}, form({ ...base, areas: "conversas" }))).toEqual({ ok: true, message: "Acesso salvo." });
    expect((await db.user.findUniqueOrThrow({ where: { id: rui.id } })).areas).toEqual(["conversas"]);
    expect(await db.session.count({ where: { userId: rui.id } })).toBe(1);
    // A new password: out of every device
    expect(await actions.saveAccessAction({}, form({ ...base, password: "outra-senha-2", areas: "conversas" }))).toMatchObject({ ok: true, message: "Acesso salvo com a senha nova." });
    expect(await db.session.count({ where: { userId: rui.id } })).toBe(0);

    // "Tirar acesso": no screen, no session, a password nobody knows
    await db.session.create({ data: { id: "rui-phone-2", userId: rui.id, expiresAt: new Date(Date.now() + 86_400_000) } });
    await actions.removeUserAccessAction(rui.id);
    const gone = await db.user.findUniqueOrThrow({ where: { id: rui.id } });
    expect(gone.areas).toEqual([]);
    expect(await db.session.count({ where: { userId: rui.id } })).toBe(0);
    expect(await auth.login("rui@exemplo.com", "outra-senha-2")).toBeNull();
    expect(homeOf(gone)).toBe("/sem-acesso");
  });
});
