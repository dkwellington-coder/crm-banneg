import { db } from "./db";

export const METRICS = [
  { key: "atendimentos", label: "Atendimentos", hint: "Leads que receberam o 1º contato no WhatsApp", money: false },
  { key: "reunioes", label: "Reuniões", hint: "Reuniões marcadas no mês", money: false },
  { key: "vendas", label: "Vendas", hint: "Leads movidos para uma etapa de ganho", money: false },
  { key: "receita", label: "Receita", hint: "Soma do valor dos negócios ganhos", money: true },
] as const;

export type MetricKey = (typeof METRICS)[number]["key"];

// São Paulo is UTC-3 all year (no daylight saving since 2019)
const SP_OFFSET_H = 3;

export function currentPeriod(now = new Date()) {
  const sp = new Date(now.getTime() - SP_OFFSET_H * 3600_000);
  return `${sp.getUTCFullYear()}-${String(sp.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodRange(period: string) {
  const [y, m] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1, SP_OFFSET_H)), end: new Date(Date.UTC(y, m, 1, SP_OFFSET_H)) };
}

export function shiftPeriod(period: string, months: number) {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodLabel(period: string) {
  const { start } = periodRange(period);
  const s = start.toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "America/Sao_Paulo" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Where the month is heading at the current pace, and how much is needed per remaining day.
 * Pure, so the math is tested; `now` outside the period means a past or future month.
 */
export function pace(actual: number, target: number, period: string, now: Date) {
  const { start, end } = periodRange(period);
  const total = end.getTime() - start.getTime();
  const elapsed = Math.min(total, Math.max(0, now.getTime() - start.getTime()));
  const fraction = elapsed / total;
  const projected = fraction > 0 ? Math.round(actual / fraction) : 0;
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - Math.max(now.getTime(), start.getTime())) / 86_400_000));
  const missing = Math.max(0, target - actual);
  return {
    percent: target > 0 ? Math.round((actual / target) * 100) : 0,
    expectedByNow: Math.round(target * fraction),
    projected,
    onTrack: target === 0 || actual >= target * fraction,
    daysLeft,
    perDay: daysLeft > 0 ? missing / daysLeft : missing,
  };
}

type Row = { userId: string | null; value: number };

/** Actual numbers for the month, for the whole team (userId null) and for each person. */
export async function actuals(period: string) {
  const { start, end } = periodRange(period);
  const [atend, reunioes, vendas] = await Promise.all([
    db.$queryRaw<{ userId: string | null; value: bigint }[]>`
      SELECT l."ownerId" AS "userId", COUNT(*) AS value FROM (
        SELECT "leadId", MIN("createdAt") AS first FROM "Message"
        WHERE channel = 'WHATSAPP' AND direction = 'OUT' AND status <> 'FAILED'
        GROUP BY "leadId"
      ) f JOIN "Lead" l ON l.id = f."leadId"
      WHERE f.first >= ${start} AND f.first < ${end}
      GROUP BY l."ownerId"`,
    db.meeting.groupBy({ by: ["userId"], where: { createdAt: { gte: start, lt: end } }, _count: true }),
    db.lead.groupBy({ by: ["ownerId"], where: { wonAt: { gte: start, lt: end } }, _count: true, _sum: { value: true } }),
  ]);
  const rows: Record<MetricKey, Row[]> = {
    atendimentos: atend.map((r) => ({ userId: r.userId, value: Number(r.value) })),
    reunioes: reunioes.map((r) => ({ userId: r.userId, value: r._count })),
    vendas: vendas.map((r) => ({ userId: r.ownerId, value: r._count })),
    receita: vendas.map((r) => ({ userId: r.ownerId, value: r._sum.value ?? 0 })),
  };
  const get = (metric: MetricKey, userId: string | null) =>
    userId === null
      ? rows[metric].reduce((sum, r) => sum + r.value, 0)
      : rows[metric].filter((r) => r.userId === userId).reduce((sum, r) => sum + r.value, 0);
  return get;
}

export function money(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
