-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "errorCode" INTEGER;

-- Failures that came before the code was kept: the same Meta errors, by their text
UPDATE "Message" SET "errorCode" = 131026 WHERE status = 'FAILED' AND error = 'Message undeliverable';
UPDATE "Message" SET "errorCode" = 131009 WHERE status = 'FAILED' AND error LIKE '(#131009)%';
UPDATE "Message" SET "errorCode" = 131049 WHERE status = 'FAILED' AND error LIKE 'This message was not delivered to maintain healthy ecosystem engagement%';
UPDATE "Message" SET "errorCode" = 130472 WHERE status = 'FAILED' AND error LIKE 'User''s number is part of an experiment%';

-- The "Erro no WhatsApp" column in every funnel, at the end (closed: no AI, no automations)
INSERT INTO "Stage" (id, "pipelineId", key, name, position, kind, color)
SELECT 'erro_' || p.id, p.id, 'erro_envio', 'Erro no WhatsApp', COALESCE(MAX(s.position), 0) + 1, 'LOST'::"StageKind", '#b91c1c'
FROM "Pipeline" p LEFT JOIN "Stage" s ON s."pipelineId" = p.id
GROUP BY p.id
ON CONFLICT ("pipelineId", key) DO NOTHING;
