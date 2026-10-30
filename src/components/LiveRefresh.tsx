"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const POLL_MS = 4_000;

/**
 * Keeps an open screen current without F5: while the tab is in front, asks `src` every few seconds for
 * the version of what is on the screen, and reloads the screen's data when it moved. Only the data
 * reloads: the message being typed, the open tab and the scroll stay where they are.
 */
export function LiveRefresh({ src, version }: { src: string; version: string }) {
  const router = useRouter();
  // What the screen shows now; a reload brings the new version along
  const shown = useRef(version);
  useEffect(() => {
    shown.current = version;
  }, [version]);

  useEffect(() => {
    let busy = false;
    const check = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const res = await fetch(src, { cache: "no-store" });
        if (!res.ok) return;
        const { version: latest } = (await res.json()) as { version: string };
        if (latest !== shown.current) {
          shown.current = latest;
          router.refresh();
        }
      } catch {
        // Offline for a moment: the next round catches up
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(check, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [src, router]);

  return null;
}
