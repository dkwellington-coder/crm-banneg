import { runDueJobs } from "@/lib/jobs";

// Called every minute by the server's scheduler (cron, Vercel Cron, or the worker script).
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const results = await runDueJobs();
  return Response.json({ ran: results.length, results });
}
