/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory Prisma test double */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Lead, Stage } from "@prisma/client";

const { mock, records, settings } = vi.hoisted(() => {
  const records: Record<string, any>[] = [], settings = new Map<string, any>();
  const mock: any = { pipeline: { findUnique: vi.fn(async () => ({ name: "Vendas de Franquias", slug: "franquias" })) },
    setting: { findUnique: vi.fn(async ({ where }: any) => settings.has(where.key) ? { value: settings.get(where.key) } : null),
      upsert: vi.fn(async ({ where, create }: any) => { if (!settings.has(where.key)) settings.set(where.key, create.value); return {}; }) },
    job: {
      upsert: vi.fn(async ({ create }: any) => { const old = records.find(j => j.dedupeKey === create.dedupeKey); if (old) return old; const job = { id: String(records.length), status: "PENDING", attempts: 0, runAt: new Date(), ...create }; records.push(job); return job; }),
      findMany: vi.fn(async () => records.filter(j => j.status === "PENDING").map(j => ({ ...j }))),
      updateMany: vi.fn(async ({ where, data }: any) => { if (!where.id) return { count: 0 }; const job = records.find(j => j.id === where.id && j.status === where.status); if (!job) return { count: 0 }; Object.assign(job, { ...data, attempts: job.attempts + 1 }); return { count: 1 }; }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(records.find(j => j.id === where.id)!, data)),
    }, lead: { findMany: vi.fn(async () => []) },
  };
  mock.$transaction = async (fn: any) => fn(mock);
  return { mock, records, settings };
});
vi.mock("@/lib/db", () => ({ db: mock }));
import { backfillCapi, capiBody, capiEvent, capiStage, franchisePipeline, queueCapi, runCapi, saveCapi } from "@/lib/meta-capi";

const stage = { id: "novo", key: "novo", name: "Novo", kind: "OPEN" } as Stage;
const lead = { id: "crm1", pipelineId: "f1", stageId: "novo", externalId: "meta:12345678901234567", phone: "(11) 98888-7777", email: " ANA@EXAMPLE.COM ", stageEnteredAt: new Date("2026-10-18T12:00:00Z") } as Lead;
beforeEach(() => {
  records.length = 0; settings.clear(); vi.clearAllMocks();
  process.env.META_DATASET_ID = "123"; process.env.META_CAPI_TOKEN = "secret-test-token";
  mock.pipeline.findUnique.mockResolvedValue({ slug: "franquias", name: "Vendas de Franquias" });
  mock.lead.findMany.mockResolvedValue([]);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events_received: 1, messages: [] })));
});
describe("Meta CAPI", () => {
  it("serializes the exact numeric Meta ID and normalized contact hashes", () => {
    const event = capiEvent(lead, stage)!;
    expect(capiBody(event)).toContain('"lead_id":12345678901234567');
    expect(event.user_data.em).toEqual([createHash("sha256").update("ana@example.com").digest("hex")]);
    expect(event.user_data.ph).toEqual([createHash("sha256").update("5511988887777").digest("hex")]);
    expect(event.event_time).toBe(1792324800);
    expect(event.custom_data).toEqual({ event_source: "crm", lead_event_source: "Banneg CRM" });
  });
  it("maps actual stages without claiming that manager handoff is a completed meeting", () => {
    expect(capiStage({ key: "com_gerente", name: "Com o gerente", kind: "OPEN" })).toBe("Com o gerente");
    for (const [key, name] of [["novo", "Lead"], ["qualificado", "Lead qualificado"], ["reuniao", "Reuniao agendada"], ["reuniao_realizada", "Reuniao realizada"], ["ganho", "Franquia vendida"], ["perdido", "Desqualificado"]]) {
      expect(capiStage({ key, name: key, kind: key === "ganho" ? "WON" : key === "perdido" ? "LOST" : "OPEN" })).toBe(name);
    }
    expect(franchisePipeline({ slug: "produtos", name: "Cotações/ Seguros e Consórcios" })).toBe(false);
    expect(franchisePipeline({ slug: "telemedicina", name: "Telemedicina" })).toBe(false);
  });
  it("deduplicates retries but preserves different transitions and reentry", async () => {
    await queueCapi(mock, lead, stage); await queueCapi(mock, lead, stage);
    expect(records).toHaveLength(1);
    await runCapi(); await queueCapi(mock, lead, stage);
    expect(records).toHaveLength(1); expect(records[0].status).toBe("DONE");
    await queueCapi(mock, { ...lead, stageEnteredAt: new Date("2026-10-19T12:00:00Z") }, stage);
    expect(records).toHaveLength(2);
  });
  it("ignores non-Meta leads and other products", async () => {
    expect(await queueCapi(mock, { ...lead, externalId: "kommo:123" }, stage)).toBeNull();
    mock.pipeline.findUnique.mockResolvedValue({ name: "Consórcios", slug: "produtos" });
    expect(await queueCapi(mock, lead, stage)).toBeNull(); expect(records).toHaveLength(0);
  });
  it("retries three times, preserves the Meta message, and removes secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Token secret-test-token expirou (#190)" } }, { status: 400 })));
    await queueCapi(mock, lead, stage);
    for (let i = 0; i < 4; i++) await runCapi();
    expect(fetch).toHaveBeenCalledTimes(4); expect(records[0].status).toBe("FAILED");
    expect(records[0].lastError).toBe("Token [credencial removida] expirou (#190)");
    await runCapi(); expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("does not fabricate recent timestamps for old history, continues after rejection", async () => {
    const older = { ...lead, id: "old", stageEnteredAt: new Date("2026-09-25T12:00:00Z"), stage, pipeline: { name: "Vendas de Franquias", slug: "franquias" } };
    mock.lead.findMany.mockResolvedValue([older]);
    await backfillCapi(); await backfillCapi(); expect(records).toHaveLength(1);
    expect(records[0].payload.event_time).toBe(Math.floor(older.stageEnteredAt.getTime() / 1000));
    expect(settings.has("meta.capi.history:old")).toBe(true);
  });
  it("does not send before credentials are configured and encrypts saved tokens", async () => {
    delete process.env.META_CAPI_TOKEN; await queueCapi(mock, lead, stage); await runCapi();
    expect(fetch).not.toHaveBeenCalled();
    process.env.WA_CREDENTIAL_KEY = "local-encryption-key";
    await saveCapi("123", "private-token"); expect(JSON.stringify(settings.get("meta_capi"))).not.toContain("private-token");
    await runCapi(); expect(records[0].status).toBe("DONE");
  });
});
