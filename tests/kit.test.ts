import { describe, expect, it } from "vitest";
import { templateComponents } from "@/lib/whatsapp";
import { findMaterial } from "@/lib/messaging";
import { attachMaterials } from "@/lib/email";
import { isStopRequest } from "@/lib/leads";
import { DEFAULT_MATERIALS } from "@/lib/settings";
import { fillVariables } from "@/lib/rules";

describe("content kit", () => {
  it("gives Meta an example for each variable of a template", () => {
    expect(templateComponents({ body: "Oi, {{1}}! Aqui é a {{2}}.", buttons: [] })[0]).toMatchObject({ example: { body_text: [["Maria", "Duda"]] } });
    expect(templateComponents({ body: "Oi, {{1}}!", buttons: ["Pode enviar"] })).toEqual([
      { type: "BODY", text: "Oi, {{1}}!", example: { body_text: [["Maria"]] } },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Pode enviar" }] },
    ]);
    expect(templateComponents({ body: "Sem variável", buttons: [] })[0]).not.toHaveProperty("example");
  });

  it("turns a material link into a WhatsApp video or PDF with the rest as caption", () => {
    const text = fillVariables("Aqui está, {{nome}}: {{video_ganhos}}\n\nMe conta: você já vende?", { nome: "Ana", ...DEFAULT_MATERIALS });
    expect(findMaterial(text, Object.values(DEFAULT_MATERIALS))).toEqual({
      url: DEFAULT_MATERIALS.video_ganhos,
      kind: "video",
      caption: "Aqui está, Ana.\n\nMe conta: você já vende?",
      filename: "como-ganhar-dinheiro.mp4",
    });
    const pdf = findMaterial(`A simulação está aqui: ${DEFAULT_MATERIALS.simulacoes}. Estimativa, antes de impostos.`, Object.values(DEFAULT_MATERIALS));
    expect(pdf).toMatchObject({ kind: "document", caption: "A simulação está aqui. Estimativa, antes de impostos.", filename: "Banneg - Simulações de rentabilidade.pdf" });
    expect(findMaterial(`${DEFAULT_MATERIALS.video_bottini}\n\nQuer ver mais?`, Object.values(DEFAULT_MATERIALS))).toMatchObject({ caption: "Quer ver mais?" });
    expect(findMaterial("Sem material aqui", Object.values(DEFAULT_MATERIALS))).toBeNull();
  });

  it("attaches the PDFs to e-mails instead of linking them, and keeps videos as links", () => {
    const body = fillVariables("Aqui está a apresentação completa:\n{{apresentacao}}\n\nE o vídeo de 1 minuto:\n{{video_ganhos}}", DEFAULT_MATERIALS);
    expect(attachMaterials(body, Object.values(DEFAULT_MATERIALS))).toEqual({
      text: `Aqui está a apresentação completa:\nBanneg - Apresentação de Valor.pdf (em anexo)\n\nE o vídeo de 1 minuto:\n${DEFAULT_MATERIALS.video_ganhos}`,
      attachments: [{ filename: "Banneg - Apresentação de Valor.pdf", href: DEFAULT_MATERIALS.apresentacao }],
    });
    expect(attachMaterials("Sem material", Object.values(DEFAULT_MATERIALS))).toEqual({ text: "Sem material", attachments: [] });
  });

  it("recognizes a request to stop messages, and only that", () => {
    for (const t of ["Parar mensagens", "PARAR", "sair", "Pare.", " stop "]) expect(isStopRequest(t)).toBe(true);
    for (const t of ["Agora não", "Não tenho interesse", "parar de trabalhar como CLT"]) expect(isStopRequest(t)).toBe(false);
  });
});
