// Artes screen (Wellington, 2026-11-27): the form's boxes become the approved Banneg layouts
import { describe, expect, it } from "vitest";
import { artFromForm, numbersFrom, stepsFrom, tableFrom } from "@/lib/art-form";
import { normalizeArt } from "@/lib/secretary-art";

describe("the Artes form", () => {
  it("reads a table, numbers and steps from plain lines", () => {
    expect(tableFrom("Carta | Prazo | Meia parcela\nR$ 80.000 | 100 meses | R$ 520,00\n")).toEqual({
      colunas: ["Carta", "Prazo", "Meia parcela"],
      linhas: [["R$ 80.000", "100 meses", "R$ 520,00"]],
    });
    expect(numbersFrom("R$ 1,4 mi | Crédito\nR$ 3,2 mi")).toEqual([{ valor: "R$ 1,4 mi", rotulo: "Crédito" }, { valor: "R$ 3,2 mi", rotulo: undefined }]);
    expect(stepsFrom("Você compra\n* Pagamos seu lance | Nós damos o lance")).toEqual([
      { titulo: "Você compra", texto: undefined, destaque: false },
      { titulo: "Pagamos seu lance", texto: "Nós damos o lance", destaque: true },
    ]);
  });

  it("keeps only the blocks of the chosen model, within what fits", () => {
    const fields = { modelo: "tabela", titulo: "Seu *jet ski*", tabela: "Carta | Prazo\nR$ 1 | 2\nR$ 3", numeros: "R$ 9 | x", selos: "Consulte vagas\n\n", rodape: "" };
    const a = normalizeArt(artFromForm(fields));
    expect(a.tabela).toEqual({ colunas: ["Carta", "Prazo"], linhas: [["R$ 1", "2"], ["R$ 3", ""]] });
    expect(a.numeros).toEqual([]);
    expect(a.itens).toEqual(["Consulte vagas"]);
    expect(a.rodape).toBe("banneg.com.br");
    expect(normalizeArt(artFromForm({ ...fields, modelo: "numeros" })).tabela).toBeNull();
  });
});
