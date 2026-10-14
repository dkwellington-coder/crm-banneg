import { z } from "zod";
import { createLead } from "@/lib/leads";

const LeadInput = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(60).optional(),
  source: z.string().max(80).default("site"),
  campaign: z.string().max(200).optional(),
});

// Site forms, landing pages and ad integrations post new leads here.
export async function POST(request: Request) {
  const token = process.env.LEADS_API_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = LeadInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  if (!parsed.data.phone && !parsed.data.email) return Response.json({ error: "phone or email required" }, { status: 400 });
  const { lead, created } = await createLead(parsed.data, `Formulário (${parsed.data.source})`);
  return Response.json({ id: lead.id, created }, { status: created ? 201 : 200 });
}
