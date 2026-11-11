import { Suspense } from "react";
import { Sidebar } from "@/components/Sidebar";
import { HealthBanner } from "@/components/HealthBanner";
import { currentUser } from "@/lib/auth";
import { areasOf } from "@/lib/areas";

/** The menu shows only the screens this person can open (Acessos); Acessos itself only for the owner. */
async function Menu() {
  const user = await currentUser();
  return <Sidebar areas={user ? areasOf(user) : []} owner={user?.role === "OWNER"} />;
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    // Phone: the page on top and the menu bar at the bottom; computer: the menu on the left
    <div className="flex h-dvh flex-col-reverse md:flex-row">
      <Suspense fallback={<nav className="h-16 shrink-0 border-slate-200 bg-white max-md:border-t md:h-auto md:w-[88px] md:border-r" />}>
        <Menu />
      </Suspense>
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Suspense fallback={null}>
          <HealthBanner />
        </Suspense>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </main>
    </div>
  );
}
