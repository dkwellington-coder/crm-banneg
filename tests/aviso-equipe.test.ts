import { describe, expect, it } from "vitest";
import { actionLabel, emailList } from "@/lib/rules";
import { leadNotice } from "@/lib/notify";

describe("emailList", () => {
  it("joins the addresses and drops repeats", () => {
    expect(emailList("Consorcios@banneg.com.br; wellington@banneg.com.br, consorcios@banneg.com.br")).toBe(
      "consorcios@banneg.com.br, wellington@banneg.com.br",
    );
  });
  it("refuses an empty list or anything that is not an e-mail", () => {
    expect(emailList("")).toBeUndefined();
    expect(emailList(undefined)).toBeUndefined();
    expect(emailList("consorcios@banneg.com.br, wellington")).toBeUndefined();
  });
});

describe("leadNotice", () => {
  const lead = {
    id: "cmlead123",
    name: "Rosival Lourenco",
    phone: "5527998004623",
    email: null,
    city: "Colatina",
    state: "ES",
    source: "Lista Produtor Rural",
    campaign: null,
    qualification: { valor_imovel: "R$ 2 milhões", parceiroFunil: "x", vazio: "" },
    aiSummary: null,
  };

  it("brings who the lead is, how to reach it, what it said and its page in the CRM", () => {
    const { subject, body } = leadNotice(lead, {
      pipeline: "Crédito com Garantia",
      stage: "Aguardando contato do consultor",
      messages: [
        { direction: "OUT", body: "Olá, Rosival! Tudo bem?", createdAt: new Date("2026-11-11T18:32:00Z") },
        { direction: "IN", body: "Quero saber mais", createdAt: new Date("2026-11-11T18:40:00Z") },
      ],
    });
    expect(subject).toBe("Quer falar com um consultor: Rosival Lourenco (Crédito com Garantia)");
    expect(body).toContain("WhatsApp: (27) 99800-4623 · https://wa.me/5527998004623");
    expect(body).toContain("Cidade: Colatina / ES");
    expect(body).toContain("Origem: Lista Produtor Rural");
    expect(body).toContain("valor_imovel: R$ 2 milhões");
    expect(body).not.toContain("parceiroFunil");
    expect(body).not.toContain("vazio");
    expect(body).toContain("11/11, 15:40 Cliente: Quero saber mais");
    expect(body).toContain("/leads/cmlead123");
    expect(body).not.toContain("E-mail:");
  });

  it("is labelled in the funnel editor with who gets it", () => {
    expect(actionLabel("notify", { to: "consorcios@banneg.com.br", cc: "wellington@banneg.com.br" })).toBe(
      "Avisar por e-mail consorcios@banneg.com.br (cópia: wellington@banneg.com.br) com os dados do lead",
    );
  });
});
