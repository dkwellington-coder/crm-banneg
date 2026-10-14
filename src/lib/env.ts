// The keys were saved in Vercel with shorter names (PHONE_NUMBER_ID, SMTP_PASSWORD...).
// Accept both spellings so nobody has to rename them; the WHATSAPP_* / SMTP_PASS names win when both exist.
const ALIASES: Record<string, string[]> = {
  WHATSAPP_PHONE_NUMBER_ID: ["PHONE_NUMBER_ID"],
  WHATSAPP_BUSINESS_ACCOUNT_ID: ["BUSINESS_ACCOUNT_ID", "WABA_ID"],
  WHATSAPP_APP_SECRET: ["APP_SECRET"],
  SMTP_PASS: ["SMTP_PASSWORD"],
};

for (const [name, alternatives] of Object.entries(ALIASES)) {
  if (process.env[name]) continue;
  const found = alternatives.find((a) => process.env[a]);
  if (found) process.env[name] = process.env[found];
}

export {};
