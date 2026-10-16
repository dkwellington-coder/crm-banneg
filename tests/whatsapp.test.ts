import { describe, expect, it, vi } from "vitest";
import { classifyError, isWindowOpen, normalizePhone, phoneVariants, verifySignature } from "@/lib/whatsapp";
import { renderTemplate } from "@/lib/email";
import { createHmac } from "node:crypto";

describe("whatsapp helpers", () => {
  it("opens the 24h window only after a recent inbound message", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    expect(isWindowOpen(null, now)).toBe(false);
    expect(isWindowOpen(new Date("2026-10-14T00:00:00Z"), now)).toBe(true);
    expect(isWindowOpen(new Date("2026-10-13T11:59:00Z"), now)).toBe(false);
  });

  it("normalizes Brazilian phone numbers", () => {
    expect(normalizePhone("(11) 92013-8123")).toBe("5511920138123");
    expect(normalizePhone("+55 11 92013-8123")).toBe("5511920138123");
  });

  it("knows a mobile WhatsApp sends without the 9 is the same number", () => {
    expect(phoneVariants("61 99325-8573")).toEqual(["5561993258573", "556193258573"]);
    expect(phoneVariants("556193258573")).toEqual(["556193258573", "5561993258573"]);
    // Landlines (2 to 5) never had a 9 to lose
    expect(phoneVariants("(11) 3456-7890")).toEqual(["551134567890"]);
  });

  it("flags the Meta payment error as an account problem", () => {
    expect(classifyError(131042, "x")).toMatchObject({ accountLevel: true });
    expect(classifyError(131026, "Message undeliverable")).toEqual({ accountLevel: false, friendly: "Message undeliverable" });
  });

  it("checks the webhook signature", () => {
    process.env.WHATSAPP_APP_SECRET = "s3cret";
    const body = '{"a":1}';
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifySignature(body, sig)).toBe(true);
    expect(verifySignature(body, "sha256=00")).toBe(false);
    delete process.env.WHATSAPP_APP_SECRET;
  });

  it("renders email variables", () => {
    expect(renderTemplate("Olá {{nome}}, veja {{ apresentacao }}", { nome: "Ana", apresentacao: "https://x" })).toBe(
      "Olá Ana, veja https://x",
    );
  });
});

import { mapRow, parseCsv } from "@/lib/csv";

describe("csv import", () => {
  it("parses a Kommo-style semicolon export with quotes", () => {
    const rows = parseCsv('﻿ID;Contato principal;Celular;Email comercial;Cidade\n123;"Silva; João";(41) 99999-0000;joao@x.com;Curitiba\n');
    expect(rows).toHaveLength(1);
    expect(mapRow(rows[0])).toMatchObject({
      name: "Silva; João",
      phone: "(41) 99999-0000",
      email: "joao@x.com",
      city: "Curitiba",
      externalId: "123",
    });
  });
});

describe("Meta send status", () => {
  it("reads the payment block from health_status without sending anything", async () => {
    const { whatsappSendStatus } = await import("@/lib/integrations");
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
    const reply = (health: unknown) => async () => new Response(JSON.stringify({ health_status: health }), { status: 200 });
    vi.stubGlobal(
      "fetch",
      reply({
        can_send_message: "BLOCKED",
        entities: [
          { entity_type: "PHONE_NUMBER", can_send_message: "AVAILABLE" },
          { entity_type: "WABA", can_send_message: "BLOCKED", errors: [{ error_code: 141006, error_description: "Problema com a forma de pagamento." }] },
        ],
      }),
    );
    expect(await whatsappSendStatus()).toEqual({ canSend: false, problem: { code: 141006, message: "Problema com a forma de pagamento." } });
    vi.stubGlobal("fetch", reply({ can_send_message: "AVAILABLE", entities: [] }));
    expect(await whatsappSendStatus()).toEqual({ canSend: true, problem: null });
    vi.unstubAllGlobals();
  });
});
