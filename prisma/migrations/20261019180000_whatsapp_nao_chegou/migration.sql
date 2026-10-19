-- The e-mail that goes when WhatsApp can't reach the lead: a button opens our WhatsApp with a message ready
INSERT INTO "EmailTemplate" (id, key, name, subject, body, "sequenceDay", active, "updatedAt")
VALUES (
  'email_whatsapp_nao_chegou',
  'whatsapp_nao_chegou',
  'WhatsApp não chegou: chame a gente',
  'Tentamos falar com você no WhatsApp',
  E'Olá, {{nome}}!\n\nAqui é a {{sdr}}, do time do {{empresa}}. Tentamos te mandar uma mensagem no WhatsApp, mas ela não chegou até você.\n\nPara conversar com a gente, toque no botão abaixo. Ele abre o WhatsApp oficial do {{empresa}} com uma mensagem pronta: é só enviar.\n\n{{link_whatsapp}}\n\nSe preferir, salve nosso número: {{numero_whatsapp}}\n\nAté já!\n{{sdr}}, time {{empresa}}',
  NULL,
  true,
  CURRENT_TIMESTAMP
)
ON CONFLICT (key) DO NOTHING;
