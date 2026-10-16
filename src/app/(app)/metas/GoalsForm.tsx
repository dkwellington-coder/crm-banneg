import Link from "next/link";
import { saveGoalsAction } from "../../actions";
import { Avatar, Card, btnCls, btnGhostCls } from "@/components/ui";
import { periodLabel } from "@/lib/goals";

export function GoalsForm({
  period,
  workingDays,
  users,
  metrics,
  values,
}: {
  period: string;
  workingDays: number;
  users: { id: string; name: string }[];
  metrics: { key: string; label: string; money: boolean }[];
  values: Record<string, number | string>;
}) {
  const rows = [{ id: "team", name: "Equipe toda" }, ...users];
  return (
    <form action={saveGoalsAction}>
      <input type="hidden" name="period" value={period} />
      <Card className="p-0">
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="text-sm font-semibold">Metas de {periodLabel(period)}</div>
          <div className="text-xs text-slate-500">
            Metas do mês inteiro. Este mês tem {workingDays} dias úteis (seg a sex): 2 por dia são {2 * workingDays}. Deixe em branco o que
            não tem meta. Receita em reais.
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="px-4 py-2 font-medium" />
                {metrics.map((m) => (
                  <th key={m.key} className="px-4 py-2 font-medium">
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className={r.id === "team" ? "bg-brand-soft/40" : ""}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2 font-medium">
                      {r.id !== "team" && <Avatar name={r.name} size={26} />}
                      {r.name}
                    </div>
                  </td>
                  {metrics.map((m) => (
                    <td key={m.key} className="px-4 py-2.5">
                      <div className="relative">
                        {m.money && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">R$</span>}
                        <input
                          name={`${m.key}:${r.id}`}
                          defaultValue={values[`${m.key}:${r.id}`]}
                          inputMode="numeric"
                          placeholder="—"
                          className={`w-full min-w-28 rounded-lg border border-slate-300 py-1.5 pr-2 text-right outline-none focus:border-brand ${m.money ? "pl-8" : "pl-2"}`}
                        />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
          <Link href={`/metas?p=${period}`} className={btnGhostCls}>
            Cancelar
          </Link>
          <button className={btnCls}>Salvar metas</button>
        </div>
      </Card>
    </form>
  );
}
