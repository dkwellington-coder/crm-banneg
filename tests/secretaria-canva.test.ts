// Jessica's Canva (Wellington, 2026-11-26): she copies one of his models from the Canva folder "Modelos Jessica", swaps
// its texts and exports a PNG, through Canva's MCP server with his login. Canva is stubbed; the DB part runs with
// TEST_DATABASE_URL.
import { beforeAll, describe, expect, it, vi } from "vitest";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {}, after() {} }));

import { matchSwaps, rpcAnswer, textsOf } from "@/lib/secretary-canva";

const CONTENT = {
  pages: [
    {
      elements: [
        { type: "shape", locator_id: "P1-S1", textContents: [] },
        { type: "text", locator_id: "P1-L1", textRegions: [{ characters: "Treinamento Online" }] },
        { type: "text", locator_id: "P1-L2", textRegions: [{ characters: "Não perca essa " }, { characters: "oportunidade" }] },
        { type: "text", locator_id: "P1-L3", textRegions: [{ characters: "04/10 às 14h" }] },
      ],
    },
  ],
};

describe("reading Canva's answers", () => {
  it("takes the answer from JSON or from an event stream", () => {
    expect(rpcAnswer('{"jsonrpc":"2.0","id":2,"result":{"ok":1}}', "application/json", 2)?.result).toEqual({ ok: 1 });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":2}}\n\n';
    expect(rpcAnswer(sse, "text/event-stream", 3)?.result).toEqual({ ok: 2 });
    expect(rpcAnswer(sse, "text/event-stream", 9)).toBeNull();
  });

  it("finds the text boxes and which one each swap is about", () => {
    const texts = textsOf(CONTENT);
    expect(texts.map((t) => t.text)).toEqual(["Treinamento Online", "Não perca essa oportunidade", "04/10 às 14h"]);
    const { plan, missing } = matchSwaps(texts, [
      { de: "treinamento online", para: "Telemedicina Banneg" },
      { de: "04/10", para: "R$ 29,90/mês" },
      { de: "Black Friday", para: "x" },
    ]);
    expect(plan).toEqual([
      { locator: "P1-L1", page: 1, text: "Telemedicina Banneg" },
      { locator: "P1-L3", page: 1, text: "R$ 29,90/mês" },
    ]);
    expect(missing).toEqual(["Black Friday"]);
  });
});

describe.skipIf(!dbUrl)("an art from his Canva model", () => {
  let db: typeof import("@/lib/db").db;
  let canva: typeof import("@/lib/secretary-canva");
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const auth: string[] = [];
  const tokenBodies: string[] = [];

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    canva = await import("@/lib/secretary-canva");
    vi.stubGlobal("fetch", async (input: string | URL, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const url = String(input);
      if (url === "https://mcp.canva.com/token") {
        tokenBodies.push(String(init.body));
        return Response.json({ access_token: "novo", refresh_token: "r2", expires_in: 3600 });
      }
      if (url.startsWith("https://export-download.canva.com/")) return new Response(Buffer.from("\x89PNG-arte"), { headers: { "content-type": "image/png" } });
      if (url !== "https://mcp.canva.com/mcp") throw new Error(`fetch inesperado: ${url}`);
      auth.push(init.headers?.Authorization ?? "");
      const msg = JSON.parse(String(init.body)) as { id?: number; method: string; params: { name: string; arguments: Record<string, unknown> } };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      if (msg.method === "initialize") return Response.json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "mcp-session-id": "s1" } });
      const { name, arguments: args } = msg.params;
      calls.push({ name, args });
      const out: Record<string, unknown> =
        name === "search-folders"
          ? { items: [{ id: "FAFoutra", name: "Modelos antigos" }, { id: "FAFjess", name: "Modelos Jessica" }] }
          : name === "list-folder-items"
            ? { items: [{ type: "design", design: { id: "DAGR_J5ht-o", title: "Convite" } }] }
            : name === "copy-design"
              ? { design: { id: "DAHcCthtTQA", urls: { edit_url: "https://www.canva.com/d/editar" } } }
              : name === "read-design"
                ? { transaction: { transaction_id: "tx1" }, design_content: CONTENT }
                : name === "export-design"
                  ? { job: { status: "success", urls: ["https://export-download.canva.com/a.png"] } }
                  : { status: "ok" };
      // Canva answers as an event stream
      const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } })}\n\n`;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    await db.setting.upsert({
      where: { key: "secretaria_canva" },
      create: { key: "secretaria_canva", value: { clientId: "c1", redirectUri: "https://crm/cb", accessToken: "velho", refreshToken: "r1", expiresAt: 0 } },
      update: { value: { clientId: "c1", redirectUri: "https://crm/cb", accessToken: "velho", refreshToken: "r1", expiresAt: 0 } },
    });
  });

  it("copies the model, swaps the texts, saves and exports, with a fresh login", async () => {
    const art = await canva.canvaArt("DAGR_J5ht-o", [{ de: "Treinamento Online", para: "Telemedicina Banneg" }], "Telemedicina");
    expect(tokenBodies[0]).toContain("grant_type=refresh_token");
    expect(auth.every((a) => a === "Bearer novo")).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["search-folders", "list-folder-items", "copy-design", "read-design", "edit-design", "edit-design", "export-design"]);
    expect(calls[2].args.design_id).toBe("DAGR_J5ht-o");
    expect(calls[4].args).toMatchObject({
      transaction_id: "tx1",
      page_index: 1,
      finalize: "keep_open",
      operations: [{ type: "update_title", title: "Jessica · Telemedicina" }, { type: "replace_text", locator_id: "P1-L1", text: "Telemedicina Banneg" }],
    });
    expect(calls[5].args).toMatchObject({ finalize: "commit" });
    expect(calls[6].args).toMatchObject({ design_id: "DAHcCthtTQA", format: { type: "png", width: 1080 } });
    expect(art.pngs[0].toString("latin1")).toContain("PNG-arte");
    expect(art.editUrl).toBe("https://www.canva.com/d/editar");
    const saved = (await db.setting.findUnique({ where: { key: "secretaria_canva" } }))!.value as { accessToken: string; refreshToken: string };
    expect(saved).toMatchObject({ accessToken: "novo", refreshToken: "r2" });
  });

  it("never touches a design outside the models folder", async () => {
    calls.length = 0;
    await expect(canva.canvaArt("DAGRyQp078U", [{ de: "x", para: "y" }], "")).rejects.toThrow('não está na pasta "Modelos Jessica"');
    expect(calls.map((c) => c.name)).toEqual(["search-folders", "list-folder-items"]);
  });

  it("lists the models with their texts and leaves them unchanged", async () => {
    calls.length = 0;
    const models = await canva.canvaModels();
    expect(models).toEqual([{ id: "DAGR_J5ht-o", nome: "Convite", textos: ["Treinamento Online", "Não perca essa oportunidade", "04/10 às 14h"] }]);
    expect(calls.at(-1)).toMatchObject({ name: "edit-design", args: { transaction_id: "tx1", finalize: "cancel" } });
  });
});
