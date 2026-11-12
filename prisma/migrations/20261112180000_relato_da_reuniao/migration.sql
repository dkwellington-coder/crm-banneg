-- What happened in each meeting, written on the Reuniões screen. Additive only.
ALTER TABLE "Meeting" ADD COLUMN "notes" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "notesAt" TIMESTAMP(3);
ALTER TABLE "Meeting" ADD COLUMN "notesBy" TEXT;
