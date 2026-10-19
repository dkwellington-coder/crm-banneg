import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Lead, Prisma, Stage } from "@prisma/client";
import { db } from "./db";

export const CAPI_JOB = "meta.capi";
const CONFIG = "meta_capi";
type Config = { datasetId?: string; token?: string };
type Store = Pick<Prisma.TransactionClient, "job" | "pipeline">;
export type CapiEvent = {
  event_name: string; event_time: number; event_id: string;
  action_source: "system_generated";
  user_data: { lead_id: string; ph?: string[]; em?: string[] };
  custom_data: { event_source: "crm"; lead_event_source: "Banneg CRM" };
};

const clean = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
export function franchisePipeline(p: { slug: string | null; name: string }) {
  return p.slug === "franquias" || /^(expansao|expansao de franquias|franquias|vendas de franquias)$/.test(clean(p.name));
}
export function capiStage(stage: Pick<Stage, "key" | "name" | "kind">): string | null {
  const name = clean(stage.name);
  if (stage.key === "reuniao_realizada" || /reuniao realizada/.test(name)) return "Reuniao realizada";
  if (stage.kind === "WON" || /fechou franquia|franquia vendida/.test(name)) return "Franquia vendida";
  if (stage.kind === "LOST" || /sem capital|desqualificado|descartado/.test(name)) return "Desqualificado";
  if (stage.key === "novo" || /^(novo|novo lead)$/.test(name)) return "Lead";
  if (stage.key === "qualificado" || /^qualificado/.test(name)) return "Lead qualificado";
  if (stage.key === "reuniao" || /reuniao (marcada|agendada)/.test(name)) return "Reuniao agendada";
  // Other real stages are sent under their own name, without inventing a completed meeting.
  return stage.name.trim() || null;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function capiEvent(lead: Pick<Lead, "externalId" | "phone" | "email" | "stageEnteredAt" | "stageId">, stage: Pick<Stage, "key" | "name" | "kind">): CapiEvent | null {
  const leadId = lead.externalId?.match(/^meta:([1-9]\d{0,24})$/)?.[1];
  const name = capiStage(stage);
  if (!leadId || !name) return null;
  let phone = lead.phone?.replace(/\D/g, "") ?? "";
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  const email = lead.email?.toLowerCase().replace(/\s/g, "");
  return {
    event_name: name, event_time: Math.floor(lead.stageEnteredAt.getTime() / 1000),
    event_id: `${leadId}-${lead.stageId}-${lead.stageEnteredAt.getTime()}`,
    action_source: "system_generated",
    user_data: { lead_id: leadId, ...(/^55\d{10,11}$/.test(phone) && { ph: [hash(phone)] }), ...(email && { em: [hash(email)] }) },
    custom_data: { event_source: "crm", lead_event_source: "Banneg CRM" },
  };
}
/** JSON numeric literal, without rounding a 17-digit Meta ID through Number(). */
export function capiBody(event: CapiEvent) {
  if (!/^[1-9]\d{0,24}$/.test(event.user_data.lead_id)) throw new Error("ID de lead Meta inválido.");
  return JSON.stringify({ data: [event] }).replace(/"lead_id":"([1-9]\d*)"/, '"lead_id":$1');
}

function encryptionKey() {
  const secret = process.env.WA_CREDENTIAL_KEY || process.env.CRON_SECRET;
  if (!secret) throw new Error("Configure WA_CREDENTIAL_KEY no servidor antes de salvar o token.");
  return createHash("sha256").update(`banneg:meta-capi:${secret}`).digest();
}
function seal(token: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString("base64url")).join(".");
}
function open(token: string) {
  const [iv, tag, data] = token.split(".").map(s => Buffer.from(s, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
async function config(): Promise<Config> {
  return (await db.setting.findUnique({ where: { key: CONFIG } }))?.value as Config ?? {};
}
export async function capiStatus() {
  const c = await config();
  return { configured: !!((c.datasetId || process.env.META_DATASET_ID) && (c.token || process.env.META_CAPI_TOKEN)) };
}
export async function capiReport() {
  return db.$queryRaw<{ event: string; status: string; error: string | null; count: number }[]>`
    SELECT payload->>'event_name' AS event, status::text AS status, "lastError" AS error, count(*)::int AS count
    FROM "Job" WHERE type = 'meta.capi'
    GROUP BY payload->>'event_name', status, "lastError" ORDER BY event, status`;
}
export async function saveCapi(datasetId: string, token: string) {
  if (!/^\d+$/.test(datasetId)) throw new Error("META_DATASET_ID deve conter apenas números.");
  const current = await config();
  if (!token && !current.token && !process.env.META_CAPI_TOKEN) throw new Error("Informe META_CAPI_TOKEN.");
  const value = { datasetId, token: token ? seal(token) : current.token ?? "" };
  await db.setting.upsert({ where: { key: CONFIG }, create: { key: CONFIG, value }, update: { value } });
}

/** Persists a snapshot; no network and no WhatsApp. Can also run in a backfill transaction. */
export async function queueCapi(store: Store, lead: Lead, stage: Stage) {
  const event = capiEvent(lead, stage);
  if (!event) return null;
  const pipeline = await store.pipeline.findUnique({ where: { id: lead.pipelineId } });
  if (!pipeline || !franchisePipeline(pipeline)) return null;
  const dedupeKey = `${CAPI_JOB}:${event.event_id}`;
  return store.job.upsert({ where: { dedupeKey }, create: {
    type: CAPI_JOB, leadId: lead.id, payload: event as unknown as Prisma.InputJsonValue,
    dedupeKey, maxAttempts: 4,
  }, update: {} });
}

/** Snapshot once per eligible lead; a permanent key makes interrupted/repeated backfills safe. */
export async function backfillCapi() {
  if (!(await capiStatus()).configured) return;
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const leads = await db.lead.findMany({ where: { externalId: { startsWith: "meta:" }, createdAt: { gte: cutoff } }, include: { stage: true, pipeline: true } });
  for (const lead of leads) {
    if (!franchisePipeline(lead.pipeline)) continue;
    await db.$transaction(async tx => {
      const marker = `meta.capi.history:${lead.id}`;
      if (await tx.setting.findUnique({ where: { key: marker } })) return;
      if (!await queueCapi(tx, lead, lead.stage)) return;
      await tx.setting.upsert({ where: { key: marker }, create: { key: marker, value: true }, update: {} });
    });
  }
}

function redact(message: string, token: string) {
  return message.split(token).join("[credencial removida]").split(encodeURIComponent(token)).join("[credencial removida]");
}
export async function runCapi(limit = 20, jobId?: string) {
  const c = await config();
  const dataset = c.datasetId || process.env.META_DATASET_ID;
  const token = c.token ? open(c.token) : process.env.META_CAPI_TOKEN;
  if (!dataset || !token) return;
  // Recover instances interrupted by a deployment or function timeout.
  await db.job.updateMany({ where: { type: CAPI_JOB, status: "RUNNING", attempts: { gte: 4 }, runAt: { lt: new Date(Date.now() - 300_000) } }, data: { status: "FAILED", finishedAt: new Date(), lastError: "Processamento interrompido após a última tentativa; recebimento não confirmado." } });
  await db.job.updateMany({ where: { type: CAPI_JOB, status: "RUNNING", attempts: { lt: 4 }, runAt: { lt: new Date(Date.now() - 300_000) } }, data: { status: "PENDING" } });
  const jobs = await db.job.findMany({ where: { type: CAPI_JOB, status: "PENDING", attempts: { lt: 4 }, runAt: { lte: new Date() }, ...(jobId && { id: jobId }) }, orderBy: { createdAt: "asc" }, take: limit });
  for (const job of jobs) {
    const claimed = await db.job.updateMany({ where: { id: job.id, status: "PENDING" }, data: { status: "RUNNING", attempts: { increment: 1 }, runAt: new Date() } });
    if (!claimed.count) continue;
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${dataset}/events`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: capiBody(job.payload as unknown as CapiEvent), signal: AbortSignal.timeout(15_000),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.error || json?.events_received !== 1) throw new Error(json?.error?.message ?? `HTTP ${res.status}: resposta sem confirmação de recebimento`);
      const result = redact(JSON.stringify({ events_received: json.events_received, messages: json.messages ?? [], fbtrace_id: json.fbtrace_id }), token);
      await db.job.update({ where: { id: job.id }, data: { status: "DONE", finishedAt: new Date(), result, lastError: null } });
    } catch (e) {
      const attempts = job.attempts + 1;
      const lastError = redact(e instanceof Error ? e.message : "Erro desconhecido no envio Meta.", token);
      await db.job.update({ where: { id: job.id }, data: {
        status: attempts >= 4 ? "FAILED" : "PENDING", lastError,
        runAt: new Date(Date.now() + 60_000 * 4 ** (attempts - 1)),
        ...(attempts >= 4 && { finishedAt: new Date() }),
      } });
    }
  }
}
