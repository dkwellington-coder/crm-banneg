-- Each funnel may start its WhatsApp conversations from its own number and with its own SDR.
-- Additive and nullable: null keeps the main number (env) and the round robin, as before.
ALTER TABLE "Pipeline" ADD COLUMN     "sdrId" TEXT,
ADD COLUMN     "whatsappNumberId" TEXT;

-- The number each lead's WhatsApp conversation is on; null = the main number
ALTER TABLE "Lead" ADD COLUMN     "whatsappNumberId" TEXT;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_sdrId_fkey" FOREIGN KEY ("sdrId") REFERENCES "SdrAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
