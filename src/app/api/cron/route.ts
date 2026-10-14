import { runDueJobs } from "@/lib/jobs";
import { db } from "@/lib/db";
import { submitTemplates, syncTemplateStatus } from "@/lib/whatsapp";
import { checkWhatsApp } from "@/lib/integrations";
import { runDailyBatches } from "@/lib/batches";

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
