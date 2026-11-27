import type { ArtInput } from "./secretary-art";

/**
 * The Artes screen (Wellington, 2026-11-27: "as gerações de artes saiam pelo CRM, com a qualidade e o branding"):
 * what the form's text boxes mean, turned into the art's blocks. One line per row; "|" splits the columns.
 */

export const ART_MODELS = [
  { key: "simples", label: "Título e foto", hint: "Chapéu, título, texto, selos" },
  { key: "tabela", label: "Oferta com tabela", hint: "Carta | Prazo | Meia parcela" },
  { key: "numeros", label: "Oferta com números", hint: "2 a 4 números grandes" },
  { key: "passos", label: "3 passos", hint: "Passo principal em dourado" },
] as const;
export type ArtModel = (typeof ART_MODELS)[number]["key"];

/** The legal lines the Banneg guides use at the bottom. */
export const LEGAL_LINES = [
  { label: "Consórcio", text: "Consórcio sem juros, com taxa de administração. Lance conforme as regras do grupo." },
  { label: "Consórcio (contemplação)", text: "Contemplação por sorteio ou lance, sem data garantida. Condições variam conforme o grupo e a administradora." },
  { label: "Simulação", text: "Simulação ilustrativa. Valores, taxas e prazos variam conforme o grupo e a administradora." },
  { label: "Oferta de grupo", text: "Cotação sujeita a disponibilidade de vaga, regras do grupo e análise da administradora." },
  { label: "Crédito rural", text: "Valores de exemplo. Sujeito à análise de crédito e avaliação do imóvel rural." },
  { label: "Tabela de prazos", text: "Valores de parcela mensal conforme a carta de crédito e o prazo." },
  { label: "Saúde", text: "Em caso de emergência, procure o pronto-socorro ou ligue 192." },
  { label: "Site", text: "banneg.com.br" },
] as const;

const rows = (v: unknown) =>
  String(v ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
const cells = (line: string) => line.split("|").map((c) => c.trim());

/** First line is the header, the next ones the rows. */
export function tableFrom(text: string): ArtInput["tabela"] {
  const [head, ...body] = rows(text);
  if (!head) return undefined;
  return { colunas: cells(head), linhas: body.map(cells) };
}

/** "R$ 1,4 mi | Crédito" per line. */
export function numbersFrom(text: string): ArtInput["numeros"] {
  return rows(text).map((l) => {
    const [valor, rotulo] = cells(l);
    return { valor, rotulo };
  });
}

/** "Título | texto" per line; a "*" at the start marks the main step (gold). */
export function stepsFrom(text: string): ArtInput["passos"] {
  return rows(text).map((l) => {
    const destaque = l.startsWith("*");
    const [titulo, texto] = cells(l.replace(/^\*\s*/, ""));
    return { titulo, texto, destaque };
  });
}

/** The art from the form: only the blocks of the chosen model. */
export function artFromForm(f: Record<string, string>): ArtInput {
  const model = (ART_MODELS.some((m) => m.key === f.modelo) ? f.modelo : "simples") as ArtModel;
  return {
    formato: f.formato,
    tema: f.tema,
    chamada: f.chamada,
    titulo: f.titulo ?? "",
    texto: f.texto,
    itens: rows(f.selos),
    rodape: f.rodape,
    botao: f.botao,
    destaque: model === "simples" ? f.destaque : undefined,
    destaque_legenda: model === "simples" ? f.destaque_legenda : undefined,
    tabela: model === "tabela" ? tableFrom(f.tabela ?? "") : undefined,
    numeros: model === "numeros" ? numbersFrom(f.numeros ?? "") : undefined,
    passos: model === "passos" ? stepsFrom(f.passos ?? "") : undefined,
  };
}
