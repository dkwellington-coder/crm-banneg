import { db } from "./db";
import { isWindowOpen, phoneVariants } from "./whatsapp";

export type BusinessHours = { start: number; end: number; days: number[]; timezone: string };

export type CrmSettings = {
  companyName: string;
  // Questions the SDR must get answered before the lead counts as qualified
  qualificationQuestions: string[];
  // Minimum score (0-100) to offer a meeting
  qualifyScore: number;
  meetingMinutes: number;
  // E-mails invited to every meeting the CRM books; Google sends them the invitation, as it does to the lead
  meetingGuests: string[];
  businessHours: BusinessHours;
  presentationUrl: string;
  // While on, WhatsApp and e-mail only really go to testContacts; the rest is recorded as simulated
  testMode: boolean;
  testContacts: string[];
  // In test mode, still really answer whoever wrote in the last 24 hours (old-lead queues stay simulated)
  answerInbound: boolean;
  // Files the AI, the automations and the e-mails send as links: {{video_ganhos}} -> URL
  materials: Record<string, string>;
};

// Public files served from /materiais on the CRM's own address
const MATERIALS_BASE = `${process.env.PUBLIC_BASE_URL ?? "https://crm-banneg-banneg.vercel.app"}/materiais`;
export const DEFAULT_MATERIALS: Record<string, string> = {
  apresentacao: `${MATERIALS_BASE}/apresentacao-de-valor.pdf`,
  por_que_investir: `${MATERIALS_BASE}/por-que-investir.pdf`,
  simulacoes: `${MATERIALS_BASE}/simulacoes-de-rentabilidade.pdf`,
  tabela_comissoes: `${MATERIALS_BASE}/tabela-de-comissoes.pdf`,
  catalogo_lojas: `${MATERIALS_BASE}/catalogo-lojas-3d.pdf`,
  video_ganhos: `${MATERIALS_BASE}/como-ganhar-dinheiro.mp4`,
  video_quanto_ganha: `${MATERIALS_BASE}/quanto-da-para-ganhar.mp4`,
  video_bottini: `${MATERIALS_BASE}/ciro-bottini.mp4`,
  video_franqueado: `${MATERIALS_BASE}/depoimento-franqueado.mp4`,
  video_fundador: `${MATERIALS_BASE}/wellington-mensagem.mp4`,
  video_fundador_podcast: `${MATERIALS_BASE}/wellington-podcast.mp4`,
  foto_fundador: `${MATERIALS_BASE}/wellington.jpg`,
  foto_fachada: `${MATERIALS_BASE}/fachada-loja.jpg`,
};

// Pretty file names for the PDFs the lead receives, on WhatsApp and as e-mail attachments
const FILE_NAMES: Record<string, string> = {
  "apresentacao-de-valor.pdf": "Banneg - Apresentação de Valor.pdf",
  "por-que-investir.pdf": "Banneg - Por que investir.pdf",
  "simulacoes-de-rentabilidade.pdf": "Banneg - Simulações de rentabilidade.pdf",
  "tabela-de-comissoes.pdf": "Banneg - Tabela de Comissões.pdf",
  "catalogo-lojas-3d.pdf": "Banneg - Catálogo de Lojas.pdf",
};

export function materialFileName(url: string) {
  const file = url.split("?")[0].split("/").pop() ?? "";
  return FILE_NAMES[file] ?? file;
}

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
  meetingGuests: [],
  businessHours: { start: 9, end: 18, days: [1, 2, 3, 4, 5], timezone: "America/Sao_Paulo" },
  presentationUrl: DEFAULT_MATERIALS.apresentacao,
  testMode: true,
  testContacts: [],
  answerInbound: false,
  materials: DEFAULT_MATERIALS,
};

/** In test mode, only listed phones (any format) and e-mails receive real messages. */
export function isTestContact(settings: Pick<CrmSettings, "testContacts">, contact: string) {
  const c = contact.trim().toLowerCase();
  const digits = c.replace(/\D/g, "");
  const mine = phoneVariants(digits);
  return settings.testContacts.some((t) => {
    const x = t.trim().toLowerCase();
    if (x.includes("@")) return x === c;
    const xd = x.replace(/\D/g, "");
    if (xd.length < 8 || digits.length < 8) return false;
    // 41999990000 matches 5541999990000, and 61 98765-4321 matches WhatsApp's 556187654321
    return phoneVariants(xd).some((v) => mine.includes(v)) || digits.endsWith(xd) || xd.endsWith(digits);
  });
}

/** Whether a WhatsApp to this lead really goes out, or is only recorded as simulated (test mode). */
export function whatsappIsReal(
  settings: Pick<CrmSettings, "testMode" | "testContacts" | "answerInbound">,
  lead: { phone: string | null; lastInboundAt: Date | null },
) {
  if (!settings.testMode) return true;
  if (lead.phone && isTestContact(settings, lead.phone)) return true;
  return settings.answerInbound && isWindowOpen(lead.lastInboundAt);
}

export async function getSettings(): Promise<CrmSettings> {
  const row = await db.setting.findUnique({ where: { key: "crm" } });
  const saved = (row?.value as Partial<CrmSettings>) ?? {};
  return { ...DEFAULT_SETTINGS, ...saved, materials: { ...DEFAULT_MATERIALS, ...saved.materials } };
}

/** {{nome}}, {{empresa}}, {{parceiro}}, {{produto}}, {{apresentacao}}, {{video_ganhos}}... for one lead. */
export function messageVars(settings: CrmSettings, lead: { name: string | null; city: string | null; qualification?: unknown }, sdrName = "") {
  const qualification = (lead.qualification ?? {}) as Record<string, unknown>;
  return {
    ...settings.materials,
    nome: lead.name?.split(" ")[0] ?? "",
    empresa: settings.companyName,
    cidade: lead.city ?? "",
    sdr: sdrName,
    // The partner store that referred the lead and what it wants a quote for (Portal de indicações)
    parceiro: typeof qualification.parceiro === "string" ? qualification.parceiro : "",
    produto: typeof qualification.produto === "string" ? qualification.produto : "",
    apresentacao: settings.presentationUrl,
  };
}

export async function saveSettings(patch: Partial<CrmSettings>) {
  const current = await getSettings();
  const value = { ...current, ...patch };
  await db.setting.upsert({ where: { key: "crm" }, create: { key: "crm", value }, update: { value } });
  return value;
}
