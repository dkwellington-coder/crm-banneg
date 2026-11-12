import { Suspense } from "react";
import Link from "next/link";
import { Mail, MessageCircle, Video } from "lucide-react";
import { canSee, LEAD_AREAS, requireArea } from "@/lib/access";
import { db } from "@/lib/db";
import { phoneLabel } from "@/lib/calendar";
import { dateTimeBr } from "@/lib/cof";
import { Card, Loading, PageHeader, fmt } from "@/components/ui";
import { MeetingOutcome, OUTCOME_LABEL } from "@/components/MeetingOutcome";
import { MeetingNotes } from "./MeetingNotes";

/**
 * Reuniões: the screen for the business manager who takes part in the meetings (Wellington, 2026-11-12).
 * Each meeting with the client's data (name, phone, e-mail, funnel), whether the COF went, and a place to write
 * what happened. Someone with only this screen never sees the funnel, the conversations or the lead's page.
 */
export default function ReunioesPage() {
  return (
    <>
      <PageHeader title="Reuniões" subtitle="Cada reunião com os dados do cliente, a COF e o relato do que aconteceu." />
      <Suspense fallback={<Loading />}>
        <Reunioes />
      </Suspense>
    </>
  );
}

const DAY = 24 * 3600_000;

const leadInclude = {
  lead: {
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      city: true,
      state: true,
      aiSummary: true,
      pipeline: { select: { name: true } },
      stage: { select: { name: true } },
      cofDeliveries: { orderBy: { sentAt: "desc" as const }, take: 1, select: { to: true, sentAt: true, openedAt: true, downloadedAt: true, confirmedAt: true } },
    },
  },
  user: { select: { name: true } },
};

async function Reunioes() {
  const user = await requireArea("reunioes");
  const now = new Date();
  const [toReport, upcoming, reported] = await Promise.all([
    // Already began, nobody wrote what happened yet (a lead who did not come needs no account)
    db.meeting.findMany({
      where: { startsAt: { lte: now, gte: new Date(now.getTime() - 30 * DAY) }, status: { in: ["scheduled", "done"] }, notes: null },
      orderBy: { startsAt: "desc" },
      take: 50,
      include: leadInclude,
    }),
    db.meeting.findMany({ where: { startsAt: { gt: now }, status: "scheduled" }, orderBy: { startsAt: "asc" }, take: 50, include: leadInclude }),
    db.meeting.findMany({
      where: { notes: { not: null }, startsAt: { gte: new Date(now.getTime() - 90 * DAY) } },
      orderBy: { startsAt: "desc" },
      take: 30,
      include: leadInclude,
    }),
  ]);
  const leadPage = canSee(user, LEAD_AREAS);
  const sections = [
    { title: "Para relatar", empty: "Nenhuma reunião esperando relato.", list: toReport, tone: "text-amber-700" },
    { title: "Próximas", empty: "Nenhuma reunião marcada.", list: upcoming, tone: "text-slate-500" },
    { title: "Relatadas", empty: "Nenhum relato ainda.", list: reported, tone: "text-slate-500" },
  ];
  return (
    <div className="space-y-6 px-4 pb-6 md:px-6">
      {sections.map((s) => (
        <section key={s.title} className="space-y-2">
          <h2 className={`text-xs font-bold uppercase tracking-wide ${s.tone}`}>
            {s.title} ({s.list.length})
          </h2>
          {s.list.length === 0 && <p className="text-sm text-slate-400">{s.empty}</p>}
          <div className="grid gap-3 xl:grid-cols-2">
            {s.list.map((m) => (
              <MeetingCard key={m.id} m={m} now={now} leadPage={leadPage} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

type Row = Awaited<ReturnType<typeof db.meeting.findMany<{ include: typeof leadInclude }>>>[number];

function MeetingCard({ m, now, leadPage }: { m: Row; now: Date; leadPage: boolean }) {
  const { lead } = m;
  const started = m.startsAt <= now;
  const place = [lead.city, lead.state].filter(Boolean).join(" / ");
  const summary = lead.aiSummary?.trim();
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-500">
            {fmt(m.startsAt)}
            {m.user && ` · com ${m.user.name.split(" ")[0]}`}
          </div>
          <div className="truncate text-lg font-semibold text-slate-900">{lead.name ?? "Lead sem nome"}</div>
          <div className="text-xs text-slate-500">
            {lead.pipeline.name} · {lead.stage.name}
            {place && ` · ${place}`}
          </div>
        </div>
        {m.status !== "scheduled" && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${m.status === "no_show" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}
          >
            {OUTCOME_LABEL[m.status] ?? m.status}
          </span>
        )}
      </div>

      <div className="grid gap-1 text-sm">
        {lead.phone ? (
          <a href={`https://wa.me/${lead.phone.replace(/\D/g, "")}`} target="_blank" className="inline-flex items-center gap-1.5 text-brand hover:underline">
            <MessageCircle size={14} /> {phoneLabel(lead.phone)}
          </a>
        ) : (
          <span className="text-slate-400">Sem telefone</span>
        )}
        {lead.email ? (
          <a href={`mailto:${lead.email}`} className="inline-flex items-center gap-1.5 break-all text-brand hover:underline">
            <Mail size={14} /> {lead.email}
          </a>
        ) : (
          <span className="text-slate-400">Sem e-mail</span>
        )}
        {m.meetLink && m.status === "scheduled" && m.endsAt > now && (
          <a href={m.meetLink} target="_blank" className="inline-flex items-center gap-1.5 text-brand hover:underline">
            <Video size={14} /> Entrar no Meet
          </a>
        )}
      </div>

      <Cof c={lead.cofDeliveries[0]} />

      {summary && (
        <details className="rounded-lg bg-sunken px-3 py-2 text-sm">
          <summary className="cursor-pointer text-xs font-semibold text-slate-600">Resumo do atendimento</summary>
          <p className="mt-1 whitespace-pre-line text-slate-700">{summary}</p>
        </details>
      )}

      {started && m.status === "scheduled" && <MeetingOutcome meetingId={m.id} />}
      {started && m.status !== "no_show" && (
        <MeetingNotes meetingId={m.id} notes={m.notes} signed={m.notesBy && m.notesAt ? `Escrito por ${m.notesBy} em ${dateTimeBr(m.notesAt)}` : null} />
      )}
      {started && m.status === "no_show" && m.notes && <p className="whitespace-pre-line text-sm text-slate-700">{m.notes}</p>}

      {leadPage && (
        <Link href={`/leads/${lead.id}`} className="inline-block text-xs text-brand underline">
          Abrir a ficha do lead
        </Link>
      )}
    </Card>
  );
}

/** Whether the COF went, and how far the lead got with it. */
function Cof({ c }: { c?: Row["lead"]["cofDeliveries"][number] }) {
  if (!c)
    return (
      <div className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
        <span className="font-semibold">COF:</span> <span className="text-slate-500">não enviada</span>
      </div>
    );
  const step = c.confirmedAt
    ? `recebimento confirmado em ${dateTimeBr(c.confirmedAt)}`
    : c.downloadedAt
      ? "baixou, ainda não confirmou"
      : c.openedAt
        ? "abriu, ainda não confirmou"
        : "ainda não abriu";
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 px-3 py-2 text-sm">
      <span className="font-semibold text-emerald-800">COF enviada</span> em {dateTimeBr(c.sentAt)} para {c.to}
      <div className="text-xs text-slate-600">{step}</div>
    </div>
  );
}
