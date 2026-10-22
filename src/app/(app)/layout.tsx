import { Suspense } from "react";
import { Sidebar } from "@/components/Sidebar";
import { HealthBanner } from "@/components/HealthBanner";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex h-screen">
      <Suspense fallback={<nav className="w-[88px] shrink-0 border-r border-slate-200 bg-white" />}>
        <Sidebar />
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
