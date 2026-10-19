"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { confirmCof } from "@/lib/cof";

/** The lead's "Confirmo que recebi": kept with the time, the IP and the device, as proof of receipt. */
export async function confirmCofAction(token: string) {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip");
  await confirmCof(token, ip ?? null, h.get("user-agent"));
  revalidatePath(`/cof/${token}`);
}
