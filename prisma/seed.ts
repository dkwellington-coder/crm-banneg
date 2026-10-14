import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

const STAGES = [
  { key: "novo", name: "Novo", color: "#64748b", staleAfterDays: 1 },
  { key: "qualificando", name: "IA qualificando", color: "#0ea5e9", staleAfterDays: null },
  { key: "qualificado", name: "Qualificado", color: "#8b5cf6", staleAfterDays: 2 },
  { key: "reuniao", name: "Reunião marcada", color: "#f59e0b", staleAfterDays: 7 },
  { key: "com_gerente", name: "Com o gerente", color: "#ec4899", staleAfterDays: 3 },
  { key: "proposta", name: "Proposta enviada", color: "#14b8a6", staleAfterDays: 5 },
  { key: "nutricao", name: "Nutrição", color: "#a3a3a3", staleAfterDays: null },
  { key: "ganho", name: "Ganho", color: "#16a34a", kind: "WON" as const, staleAfterDays: null },
  { key: "perdido", name: "Perdido", color: "#dc2626", kind: "LOST" as const, staleAfterDays: null },
  { key: "descartado", name: "Descartado", color: "#71717a", kind: "LOST" as const, staleAfterDays: null },
];

const PERSONA_BASE =
  "Você representa a área de expansão de franquias. Fale como uma pessoa real do time, nunca diga que é um robô a menos que perguntem diretamente; se perguntarem, diga que é a assistente virtual da equipe.";

const EMAILS = [
  {
    key: "boas_vindas_0",
    name: "Boas-vindas + apresentação",
    sequenceDay: 0,
    subject: "{{nome}}, sua apresentação da franquia {{empresa}}",
    body: `Olá, {{nome}}!

Obrigado pelo interesse em ser um franqueado {{empresa}}.

Separei a nossa apresentação completa para você conhecer o modelo com calma:
{{apresentacao}}

Nela você vai ver como funciona a operação, o suporte que o franqueado recebe e os próximos passos.

Se preferir, responda este e-mail ou chame no WhatsApp: a nossa equipe de expansão está à disposição.

Um abraço,
Equipe de Expansão {{empresa}}`,
  },
  {
    key: "boas_vindas_2",
    name: "Dúvidas frequentes",
    sequenceDay: 2,
    subject: "As 3 perguntas que todo futuro franqueado {{empresa}} faz",
    body: `Olá, {{nome}}!

Quem chega até a {{empresa}} costuma perguntar:

1. Quanto preciso investir?
2. Em quanto tempo a unidade começa a operar?
3. Que apoio vou ter no dia a dia?

As respostas estão na apresentação: {{apresentacao}}

Quer conversar com um consultor de expansão para tirar as dúvidas da sua região? É só responder este e-mail.

Equipe de Expansão {{empresa}}`,
  },
  {
    key: "boas_vindas_5",
    name: "Convite para reunião",
    sequenceDay: 5,
    subject: "{{nome}}, vamos conversar sobre a sua unidade?",
    body: `Olá, {{nome}}!

Uma conversa de 30 minutos com o nosso gerente de expansão costuma responder tudo o que falta para você decidir.

Responda este e-mail com o melhor dia e horário, ou chame a gente no WhatsApp, que marcamos.

Equipe de Expansão {{empresa}}`,
  },
  {
    key: "nutricao_7",
    name: "Nutrição: o modelo de negócio",
    sequenceDay: 7,
    subject: "Como funciona uma unidade {{empresa}} por dentro",
    body: `Olá, {{nome}}!

Sabemos que abrir uma franquia é uma decisão para o momento certo. Enquanto isso, deixo de novo a apresentação para quando quiser rever: {{apresentacao}}

Quando fizer sentido, é só responder este e-mail.

Equipe de Expansão {{empresa}}`,
  },
  {
    key: "nutricao_30",
    name: "Nutrição: retomada",
    sequenceDay: 30,
    subject: "{{nome}}, ainda pensando em empreender?",
    body: `Olá, {{nome}}!

Passou um mês desde a nossa última conversa. Se o seu momento mudou, temos novidades e regiões disponíveis.

Responda este e-mail e um consultor fala com você.

Equipe de Expansão {{empresa}}`,
  },
];

async function main() {
  for (const [position, s] of STAGES.entries()) {
    await db.stage.upsert({
      where: { key: s.key },
      create: { ...s, position, kind: s.kind ?? "OPEN" },
      update: { position },
    });
  }
  for (const [name, style] of [
    ["Duda", "Seu estilo: calorosa, animada e próxima."],
    ["Alice", "Seu estilo: objetiva, consultiva e muito clara."],
  ]) {
    await db.sdrAgent.upsert({ where: { name }, create: { name, persona: `${PERSONA_BASE} ${style}` }, update: {} });
  }
  for (const e of EMAILS) await db.emailTemplate.upsert({ where: { key: e.key }, create: e, update: {} });

  const email = (process.env.SEED_OWNER_EMAIL ?? "wellington@banneg.com.br").toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD;
  if (!(await db.user.findUnique({ where: { email } }))) {
    if (!password) throw new Error("Defina SEED_OWNER_PASSWORD para criar o primeiro usuário.");
    await db.user.create({
      data: { name: process.env.SEED_OWNER_NAME ?? "Wellington", email, role: "OWNER", passwordHash: await bcrypt.hash(password, 10) },
    });
  }
  if ((await db.knowledgeItem.count()) === 0) {
    await db.knowledgeItem.create({
      data: {
        title: "Apresentação",
        content: "Link da apresentação da franquia: https://crm.banneg.com.br/materiais/banneg-apresentacao-franquia.pdf",
      },
    });
  }
  console.log("Seed concluído.");
}

main().finally(() => db.$disconnect());
