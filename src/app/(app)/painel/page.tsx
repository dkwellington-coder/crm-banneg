import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { daysAgo } from "@/lib/time";
import { Card, Loading, PageHeader, Tabs, tabCls } from "@/components/ui";

export default function PainelPage({ searchParams }: PageProps<"/painel">) {
  return (
    <>
      <PageHeader title="Painel" subtitle="Onde os leads estão, onde travam e o que a IA está entregando." />
      <Suspense fallback={<Loading />}>
        <Dashboard searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const ADVANCED = ["QUALIFIED", "MEETING_BOOKED", "HANDED_OFF", "WON"] as const;

async function Dashboard({ searchParams }: { searchParams: PageProps<"/painel">["searchParams"] }) {
  await requireUser();
  const sp = await searchParams;
  const days = [7, 30, 90].includes(Number(sp.d)) ? Number(sp.d) : 30;
  const since = daysAgo(days);
  const inPeriod = { createdAt: { gte: since } };

  const [received, qualified, meetings, won, stages, stageCounts, firstResponse, bySdr, bySource, jobs] = await Promise.all([
    db.lead.count({ where: inPeriod }),
    db.lead.count({ where: { ...inPeriod, status: { in: [...ADVANCED] } } }),
    db.meeting.count({ where: inPeriod }),
    db.lead.count({ where: { status: "WON", updatedAt: { gte: since } } }),
    db.stage.findMany({ orderBy: { position: "asc" } }),
    db.lead.groupBy({ by: ["stageId"], _count: true }),
    db.$queryRaw<{ avg_minutes: number | null; median_minutes: number | null }[]>`
      SELECT AVG(m) AS avg_minutes, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY m) AS median_minutes FROM (
        SELECT EXTRACT(EPOCH FROM (MIN(msg."createdAt") - l."createdAt")) / 60 AS m
        FROM "Lead" l JOIN "Message" msg ON msg."leadId" = l.id AND msg.direction = 'OUT' AND msg.channel = 'WHATSAPP' AND msg.status <> 'FAILED'
        WHERE l."createdAt" >= ${since}
        GROUP BY l.id, l."createdAt"
      ) t`,
    db.$queryRaw<{ name: string; leads: bigint; advanced: bigint; meetings: bigint }[]>`
      SELECT a.name,
        COUNT(l.id) AS leads,
        COUNT(l.id) FILTER (WHERE l.status IN ('QUALIFIED','MEETING_BOOKED','HANDED_OFF','WON')) AS advanced,
        COUNT(DISTINCT mt.id) AS meetings
      FROM "SdrAgent" a
      LEFT JOIN "Lead" l ON l."sdrId" = a.id AND l."createdAt" >= ${since}
      LEFT JOIN "Meeting" mt ON mt."leadId" = l.id
      GROUP BY a.name ORDER BY a.name`,
    db.$queryRaw<{ source: string; leads: bigint; advanced: bigint }[]>`
      SELECT source, COUNT(*) AS leads,
        COUNT(*) FILTER (WHERE status IN ('QUALIFIED','MEETING_BOOKED','HANDED_OFF','WON')) AS advanced
      FROM "Lead" WHERE "createdAt" >= ${since} GROUP BY source ORDER BY leads DESC LIMIT 10`,
    db.job.groupBy({ by: ["type", "status"], where: { createdAt: { gte: since } }, _count: true }),
  ]);

  const countBy = new Map(stageCounts.map((c) => [c.stageId, c._count]));
  const maxStage = Math.max(1, ...stageCounts.map((c) => c._count));
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const fr = firstResponse[0];
  const minutes = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : v < 60 ? `${Math.round(v)} min` : `${(v / 60).toFixed(1)} h`;
  const jobTypes = [...new Set(jobs.map((j) => j.type))];
  const jobCount = (type: string, status: string) => jobs.find((j) => j.type === type && j.status === status)?._count ?? 0;

  return (
    <div className="space-y-4 px-6 pb-6">
      <Tabs>
        {[7, 30, 90].map((d) => (
          <Link key={d} href={`/painel?d=${d}`} className={tabCls(d === days)}>
            {d} dias
          </Link>
        ))}
      </Tabs>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Leads recebidos" value={received} />
        <Kpi label="1ª resposta (mediana)" value={minutes(fr?.median_minutes)} hint={`média ${minutes(fr?.avg_minutes)}`} />
        <Kpi label="Qualificados" value={qualified} hint={`${pct(qualified, received)} dos leads`} />
        <Kpi label="Reuniões marcadas" value={meetings} hint={`${pct(meetings, qualified)} dos qualificados`} />
        <Kpi label="Vendas ganhas" value={won} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-bold">Funil agora</h2>
          <div className="space-y-2">
            {stages.map((s) => {
              const n = countBy.get(s.id) ?? 0;
              return (
                <div key={s.id} className="text-sm">
                  <div className="flex justify-between">
                    <span>{s.name}</span>
                    <span className="font-semibold">{n}</span>
                  </div>
                  <div className="h-2 rounded bg-slate-100">
                    <div className="h-2 rounded" style={{ width: `${(n / maxStage) * 100}%`, background: s.color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 font-bold">SDRs de IA</h2>
            <Table
              head={["SDR", "Leads", "Qualificados", "Reuniões"]}
              rows={bySdr.map((r) => [r.name, Number(r.leads), `${Number(r.advanced)} (${pct(Number(r.advanced), Number(r.leads))})`, Number(r.meetings)])}
            />
          </Card>
          <Card>
            <h2 className="mb-2 font-bold">Origem dos leads</h2>
            <Table
              head={["Origem", "Leads", "Qualificados"]}
              rows={bySource.map((r) => [r.source, Number(r.leads), `${Number(r.advanced)} (${pct(Number(r.advanced), Number(r.leads))})`])}
            />
          </Card>
          <Card>
            <h2 className="mb-2 font-bold">Automações</h2>
            <Table
              head={["Tipo", "Concluídas", "Agendadas", "Falharam"]}
              rows={jobTypes.map((t) => [t, jobCount(t, "DONE"), jobCount(t, "PENDING"), jobCount(t, "FAILED")])}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {hint && <div className="text-xs text-slate-400">{hint}</div>}
    </Card>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  if (!rows.length) return <p className="text-sm text-slate-400">Sem dados no período.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-slate-500">
          {head.map((h, i) => (
            <th key={h} className={`pb-1 font-medium ${i ? "text-right" : ""}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={String(r[0])} className="border-t border-slate-100">
            {r.map((c, i) => (
              <td key={i} className={`py-1 ${i ? "text-right" : ""}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
