import { runDueJobs } from "@/lib/jobs";
import { db } from "@/lib/db";
import { getHealth, setHealth, submitTemplates, syncTemplateStatus } from "@/lib/whatsapp";
import { checkWhatsApp, whatsappSendStatus } from "@/lib/integrations";
import { runDailyBatches } from "@/lib/batches";
import { pullMetaLeads } from "@/lib/meta-leads";
import { syncAdSpend } from "@/lib/meta-ads";
import { forwardTarget } from "@/lib/whatsapp-forward";

// Called every minute by the server's scheduler (cron, Vercel Cron, or the worker script).
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const minute = new Date().getMinutes();
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
  if (minute % 30 === 20 && (process.env.META_ADS_TOKEN || process.env.META_LEADS_TOKEN)) {
    // What each campaign spent, to put a cost on leads and sales (the first read brings 90 days)
    meta.ads = await syncAdSpend().catch((e: Error) => ({ error: e.message }));
  }
  if (minute % 10 === 5) {
    // Meta's own answer on whether the number can send (a pending payment blocks it): pauses the
    // queues and shows the banner while blocked, and clears both as soon as Meta releases it
    const sending = await whatsappSendStatus().catch(() => null);
    if (sending?.problem) await setHealth(sending.problem);
    else if (sending?.canSend && (await getHealth())) await setHealth(null);
    if (sending) meta.sending = sending;
    // Where copies of the WhatsApp messages go (the old CRM); asked from Meta at most once an hour
    meta.copyTo = await forwardTarget().catch((e: Error) => ({ error: e.message }));
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
