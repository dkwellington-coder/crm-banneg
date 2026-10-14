import { db } from "./db";

export type BusinessHours = { start: number; end: number; days: number[]; timezone: string };

export type CrmSettings = {
  companyName: string;
  // Questions the SDR must get answered before the lead counts as qualified
  qualificationQuestions: string[];
  // Minimum score (0-100) to offer a meeting
  qualifyScore: number;
  meetingMinutes: number;
  businessHours: BusinessHours;
  presentationUrl: string;
  // While on, WhatsApp and e-mail only really go to testContacts; the rest is recorded as simulated
  testMode: boolean;
  testContacts: string[];
};

export const DEFAULT_SETTINGS: CrmSettings = {
  companyName: "Banneg",
  qualificationQuestions: [
    "Nome completo",
    "Cidade e estado onde quer abrir a franquia",
    "Capital disponível para investir",
    "Prazo para começar (imediato, até 3 meses, até 6 meses, mais de 6 meses)",
    "Já é empresário ou vai empreender pela primeira vez",
    "Quem decide o investimento (só a pessoa ou com sócio/cônjuge)",
  ],
  qualifyScore: 60,
  meetingMinutes: 30,
  businessHours: { start: 9, end: 18, days: [1, 2, 3, 4, 5], timezone: "America/Sao_Paulo" },
  presentationUrl: "https://crm.banneg.com.br/materiais/banneg-apresentacao-franquia.pdf",
  testMode: true,
  testContacts: [],
};

/** In test mode, only listed phones (any format) and e-mails receive real messages. */
export function isTestContact(settings: Pick<CrmSettings, "testContacts">, contact: string) {
  const c = contact.trim().toLowerCase();
  const digits = c.replace(/\D/g, "");
  return settings.testContacts.some((t) => {
    const x = t.trim().toLowerCase();
    if (x.includes("@")) return x === c;
    const xd = x.replace(/\D/g, "");
    // 41999990000 matches 5541999990000
    return xd.length >= 8 && digits.length >= 8 && (digits.endsWith(xd) || xd.endsWith(digits));
  });
}

export async function getSettings(): Promise<CrmSettings> {
  const row = await db.setting.findUnique({ where: { key: "crm" } });
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<CrmSettings>) ?? {}) };
}

export async function saveSettings(patch: Partial<CrmSettings>) {
  const current = await getSettings();
  const value = { ...current, ...patch };
  await db.setting.upsert({ where: { key: "crm" }, create: { key: "crm", value }, update: { value } });
  return value;
}
