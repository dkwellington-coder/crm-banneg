-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "seenAt" TIMESTAMP(3);

-- Leads that were already in the CRM are not "new": only the ones that arrive from now on light up the alert
UPDATE "Lead" SET "seenAt" = "createdAt";
