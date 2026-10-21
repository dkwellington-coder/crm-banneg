import { runDueJobs } from "@/lib/jobs";
import { db } from "@/lib/db";
import { clearHealth, refreshWhatsAppNumbers, setHealth, submitTemplates, syncTemplateStatus } from "@/lib/whatsapp";
import { checkCalendar, checkFunnelNumbers, checkTranscription, checkWhatsApp, whatsappSendStatus } from "@/lib/integrations";
import { googleConfigured } from "@/lib/google";
import { runDailyBatches } from "@/lib/batches";
import { auditMetaLeadsIfDue, pullMetaLeads } from "@/lib/meta-leads";
import { syncAdSpend } from "@/lib/meta-ads";
import { forwardTarget } from "@/lib/whatsapp-forward";
import { backfillCapi, runCapi } from "@/lib/meta-capi";

// Called every minute by the server's scheduler (cron, Vercel Cron, or the worker script).
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const minute = new Date().getMinutes();
  await backfillCapi().catch(() => console.error("Meta CAPI: falha ao preparar histórico."));
  await runCapi(3).catch(() => console.error("Meta CAPI: falha ao processar fila."));
  const batches = await runDailyBatches().catch((e: Error) => ({ error: e.message }));
  const results = await runDueJobs();
  const meta: Record<string, unknown> = {};
  if (minute % 10 === 0 && process.env.WHATSAPP_BUSINESS_ACCOUNT_ID && process.env.WHATSAPP_TOKEN) {
    // Every template in the CRM was approved by the team: new ones go to Meta's review on their own
    if (await db.whatsAppTemplate.count({ where: { status: "draft" } })) meta.submitted = await submitTemplates().catch((e: Error) => e.message);
    // Templates under Meta's review: start using the approved ones
    if (await db.whatsAppTemplate.count({ where: { status: { in: ["PENDING", "IN_APPEAL"] } } }))
      meta.synced = await syncTemplateStatus().catch((e: Error) => e.message);
  }
  if (minute % 2 === 1 && (process.env.META_LEADS_TOKEN || process.env.WHATSAPP_TOKEN)) {
    // New Facebook and Instagram form leads, read straight from the forms
    meta.forms = await pullMetaLeads().catch((e: Error) => ({ error: e.message }));
  }
  if (minute % 30 === 15 && (process.env.META_LEADS_TOKEN || process.env.WHATSAPP_TOKEN)) {
    // Twice a day: the last 30 days of every form against the CRM, so no campaign lead is lost on the way
    meta.formsAudit = await auditMetaLeadsIfDue()
      .then((a) => a && { total: a.total, missing: a.missing.length, error: a.error })
      .catch((e: Error) => ({ error: e.message }));
  }
  if (minute % 30 === 20 && (process.env.META_ADS_TOKEN || process.env.META_LEADS_TOKEN)) {
    // What each campaign spent, to put a cost on leads and sales (the first read brings 90 days)
    meta.ads = await syncAdSpend().catch((e: Error) => ({ error: e.message }));
  }
  if (minute % 10 === 5) {
    // Meta's own answer on whether the number can send (a pending payment blocks it): pauses the
    // queues and shows the banner while blocked, and clears both as soon as Meta releases it
    const sending = await whatsappSendStatus().catch(() => null);
    if (sending?.problem) await setHealth(sending.problem);
    else if (sending?.canSend) await clearHealth();
    if (sending) meta.sending = sending;
    // The funnels' own numbers too (one Meta blocks or refuses; a new number in name review only sends with a limit): the
    // banner says which one is stopped
    await checkFunnelNumbers().catch(() => console.error("WhatsApp: falha ao conferir os números dos funis."));
    // Where copies of the WhatsApp messages go (the old CRM); asked from Meta at most once an hour
    meta.copyTo = await forwardTarget().catch((e: Error) => ({ error: e.message }));
    // The account's numbers, for each funnel's "Número do WhatsApp"; read from Meta at most once an hour, never throws
    meta.numbers = await refreshWhatsAppNumbers({ ifOlderThanMs: 3600_000 }).then((n) => n && { count: n.numbers.length, error: n.error ?? null });
    // Lead audios are transcribed for the AI: proven once a day (and an hour after a failure)
    const last = (await db.setting.findUnique({ where: { key: "audio_check" } }))?.value as { ok?: boolean; at?: string } | undefined;
    const age = last?.at ? Date.now() - new Date(last.at).getTime() : Infinity;
    if (age > (last?.ok ? 86_400_000 : 3_600_000)) {
      const value = { ...(await checkTranscription()), at: new Date().toISOString() };
      await db.setting.upsert({ where: { key: "audio_check" }, create: { key: "audio_check", value }, update: { value } });
      meta.audio = value;
    }
    // The owner's Google agenda (meetings with Meet): proven once a day, an hour after a failure, and right after connecting
    const cal = (await db.setting.findUnique({ where: { key: "calendar_check" } }))?.value as { ok?: boolean; at?: string } | undefined;
    const calAge = cal?.at ? Date.now() - new Date(cal.at).getTime() : Infinity;
    const owner = googleConfigured() ? await db.user.findFirst({ where: { role: "OWNER" }, orderBy: { createdAt: "asc" } }) : null;
    if (owner && calAge > (cal?.ok ? 86_400_000 : 3_600_000)) {
      const value = { ...(await checkCalendar(owner.id)), at: new Date().toISOString() };
      await db.setting.upsert({ where: { key: "calendar_check" }, create: { key: "calendar_check", value }, update: { value } });
      meta.calendar = value;
    }
  }
  if (minute % 30 === 0) {
    // Kept for the Integrações screen and for support: which number is connected and its sending tier
    const check = await checkWhatsApp();
    await db.setting.upsert({
      where: { key: "whatsapp_check" },
      create: { key: "whatsapp_check", value: { ...check, at: new Date().toISOString() } },
      update: { value: { ...check, at: new Date().toISOString() } },
    });
    meta.check = check;
  }
  return Response.json({ ran: results.length, results, batches, ...meta });
}
