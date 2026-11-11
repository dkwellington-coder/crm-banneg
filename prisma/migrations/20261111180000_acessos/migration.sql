-- Screens each person on the team can open (Acessos). Everyone already there keeps seeing everything. Additive only.
ALTER TABLE "User" ADD COLUMN "areas" TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[];
