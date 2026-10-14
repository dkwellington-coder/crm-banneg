import { runDueJobs } from "@/lib/jobs";
import { db } from "@/lib/db";
import { syncTemplateStatus } from "@/lib/whatsapp";

// Called every minute by the server's scheduler (cron, Vercel Cron, or the worker script).
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const results = await runDueJobs();
  // Templates under Meta's review: check every 10 minutes and start using the approved ones
  if (new Date().getMinutes() % 10 === 0 && (await db.whatsAppTemplate.count({ where: { status: "PENDING" } }))) {
    await syncTemplateStatus().catch(() => null);
  }
  return Response.json({ ran: results.length, results });
}
