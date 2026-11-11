import { redirect } from "next/navigation";
import { requireUser } from "./auth";
import { canSee, homeOf, type Area } from "./areas";

export * from "./areas";

/** Signed in and allowed on this screen (any of them, for a list); else to the first screen the person has. */
export async function requireArea(area: Area | readonly Area[]) {
  const user = await requireUser();
  if (!canSee(user, area)) redirect(homeOf(user));
  return user;
}

/** Acessos: the owner only. */
export async function requireOwnerPage() {
  const user = await requireUser();
  if (user.role !== "OWNER") redirect(homeOf(user));
  return user;
}
