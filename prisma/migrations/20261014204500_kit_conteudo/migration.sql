-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "whatsappOptOut" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WhatsAppTemplate" ADD COLUMN     "buttons" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'MARKETING',
ADD COLUMN     "metaNote" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'APPROVED';
