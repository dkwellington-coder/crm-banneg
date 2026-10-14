import { Suspense } from "react";
import { Sidebar } from "@/components/Sidebar";
import { HealthBanner } from "@/components/HealthBanner";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex h-screen">
      <Suspense fallback={<nav className="w-20 shrink-0 bg-brand" />}>
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
