-- The notice of every booked meeting to the team's WhatsApp (src/lib/team-alert.ts). A draft: the cron sends it to
-- Meta for review, and it is used once approved. Until then the plain text only reaches whoever wrote in the last 24 h.
INSERT INTO "WhatsAppTemplate" ("id", "name", "language", "body", "purpose", "active", "category", "buttons", "status")
VALUES (
  'wat_aviso_reuniao_equipe',
  'banneg_aviso_reuniao_equipe',
  'pt_BR',
  E'Nova reunião marcada pelo CRM do Banneg.\n\nCliente: {{1}}\nWhatsApp: {{2}}\nQuando: {{3}}, horário de Brasília\nLink da reunião: {{4}}\nFicha no CRM: {{5}}\n\nMarcada por {{6}}. Bom atendimento!',
  'team_alert',
  false,
  'UTILITY',
  '[]',
  'draft'
)
ON CONFLICT ("name") DO NOTHING;
