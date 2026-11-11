// The screens of the CRM a person can be given in Acessos. No server imports: the menu (a client component) reads it too.
// A user read before the field existed (or a test double) has no list: everything, as before Acessos
type Who = { role: string; areas?: string[] | null };

/** The screens the owner can open or close for each person in Acessos. */
export const AREAS = [
  { key: "funil", label: "Funil", hint: "Funil, leads e edição dos funis", href: "/funil" },
  { key: "conversas", label: "Conversas", hint: "Conversas do WhatsApp", href: "/conversas" },
  { key: "agenda", label: "Agenda", hint: "Reuniões marcadas", href: "/agenda" },
  { key: "metas", label: "Metas", hint: "Metas e resultados do time", href: "/metas" },
  { key: "painel", label: "Painel", hint: "Números e campanhas", href: "/painel" },
  { key: "simulador", label: "Simulador", hint: "Testar a IA", href: "/simulador" },
  { key: "integracoes", label: "Integrar", hint: "WhatsApp, Meta, Google e formulários", href: "/integracoes" },
  { key: "configuracoes", label: "Ajustes", hint: "IA, e-mails, modelos e macros", href: "/configuracoes" },
] as const;

export type Area = (typeof AREAS)[number]["key"];

// A lead's page opens from the funnel, a conversation or the agenda: any of them lets the person work the lead
export const LEAD_AREAS: readonly Area[] = ["funil", "conversas", "agenda"];

const ALL = AREAS.map((a) => a.key) as Area[];

/** What this person can open: the owner and "*" everything, else only the screens ticked in Acessos. */
export function areasOf(user: Who): Area[] {
  const areas = user.areas ?? ["*"];
  if (user.role === "OWNER" || areas.includes("*")) return ALL;
  return ALL.filter((a) => areas.includes(a));
}

export function canSee(user: Who, area: Area | readonly Area[]) {
  const mine = areasOf(user);
  return (typeof area === "string" ? [area] : area).some((a) => mine.includes(a));
}

/** Where to send someone who opened a screen that is closed to them. */
export function homeOf(user: Who) {
  const first = areasOf(user)[0];
  return first ? AREAS.find((a) => a.key === first)!.href : "/sem-acesso";
}

/** Only the ticked screens: given back from the Acessos form, "*" when all are ticked. */
export function cleanAreas(picked: string[]): string[] {
  const valid = ALL.filter((a) => picked.includes(a));
  return valid.length === ALL.length ? ["*"] : valid;
}

