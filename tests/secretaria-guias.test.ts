// Banneg's standard guides (Wellington, 2026-11-26): Jessica reads the marketing and consórcio guides and keeps their look
import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {}, after() {} }));

import { docIdFrom, findGuide, type Guide } from "@/lib/secretary-guides";
import { guidesRule } from "@/lib/secretary-ai";
import { plainTitle, titleWords } from "@/lib/secretary-art";

const g = (nome: string): Guide => ({ nome, docId: nome, texto: "", lidoEm: "2026-11-26T20:00:00Z" });

describe("the Banneg guides", () => {
  it("takes the id from a Google Docs link", () => {
    expect(docIdFrom("https://docs.google.com/document/d/1OoOZaU8VRzBz1KG6BAe467TO0qDJpGoeNg_S4PSc9Ig/edit")).toBe("1OoOZaU8VRzBz1KG6BAe467TO0qDJpGoeNg_S4PSc9Ig");
    expect(docIdFrom("drive.google.com/open?id=1UkSnRCcCxh-ctmDtH-z1TbHOoMGGxIhsdWdoq6rcD64")).toBe("1UkSnRCcCxh-ctmDtH-z1TbHOoMGGxIhsdWdoq6rcD64");
    expect(docIdFrom("guia de marketing")).toBeNull();
  });

  it("finds a guide by a loose name", () => {
    const list = [g("Marketing"), g("Consórcios")];
    expect(findGuide(list, "marketing")?.nome).toBe("Marketing");
    expect(findGuide(list, "consorcio")?.nome).toBe("Consórcios");
    expect(findGuide(list, "guia de consórcios")?.nome).toBe("Consórcios");
    expect(findGuide(list, "jurídico")).toBeNull();
  });

  it("tells her to read them and keeps the essentials in her prompt", () => {
    const rule = guidesRule(["Marketing", "Consórcios"]);
    expect(rule).toContain('"Marketing", "Consórcios"');
    expect(rule).toContain("guia_banneg");
    expect(rule).toContain("*meia parcela*");
    expect(rule).toContain("#TemBannegPraIsso");
  });

  it("marks the key word of the title for gold italic", () => {
    expect(titleWords("Seu jet ski com *meia parcela* até a contemplação")).toEqual([
      { word: "Seu", key: false },
      { word: "jet", key: false },
      { word: "ski", key: false },
      { word: "com", key: false },
      { word: "meia", key: true },
      { word: "parcela", key: true },
      { word: "até", key: false },
      { word: "a", key: false },
      { word: "contemplação", key: false },
    ]);
    expect(plainTitle("Falta *crédito* no Agro?")).toBe("Falta crédito no Agro?");
  });
});
