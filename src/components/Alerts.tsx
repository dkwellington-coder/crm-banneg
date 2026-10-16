"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Bell, BellOff, BellRing, UserPlus, MessageCircle, X } from "lucide-react";
import type { Alert, TeamAlerts } from "@/lib/alerts";

const POLL_MS = 15_000;
const SOUND_PREF = "crm_alerts_sound";
// Keys already announced by any open tab, so three open tabs ring once
const RANG = "crm_alerts_rang";

type Permission = NotificationPermission | "unsupported";

function storage<T>(fn: (s: Storage) => T, fallback: T) {
  try {
    return fn(window.localStorage);
  } catch {
    return fallback;
  }
}

// Sound on/off and the browser's notification permission, shared by every component and tab
const PREFS_EVENT = "crm-alerts-prefs";

function subscribePrefs(onChange: () => void) {
  window.addEventListener(PREFS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREFS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const soundIsOn = () => storage((s) => s.getItem(SOUND_PREF) !== "off", true);
const notificationPermission = (): Permission => ("Notification" in window ? Notification.permission : "unsupported");

function setSoundPref(on: boolean) {
  storage((s) => s.setItem(SOUND_PREF, on ? "on" : "off"), undefined);
  window.dispatchEvent(new Event(PREFS_EVENT));
}

/** True when no other tab announced these keys yet; marks them as announced. */
function claim(keys: string[]) {
  return storage((s) => {
    const rang: string[] = JSON.parse(s.getItem(RANG) ?? "[]");
    const fresh = keys.filter((k) => !rang.includes(k));
    if (!fresh.length) return false;
    s.setItem(RANG, JSON.stringify([...fresh, ...rang].slice(0, 300)));
    return true;
  }, true);
}

let audio: AudioContext | null = null;

/** Browsers only play sound after the first click on the page: this opens the audio on that click. */
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    // No Web Audio: the pop-up and the red badge still warn
  }
}

/** A short two-note "plim", like a message arriving on the phone. */
export function ding() {
  unlockAudio();
  if (!audio) return;
  const t = audio.currentTime;
  for (const [delay, freq] of [
    [0, 1046.5],
    [0.13, 1318.5],
  ]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(0.3, t + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.22);
    osc.connect(gain).connect(audio.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 0.25);
  }
}

const TITLE: Record<Alert["kind"], string> = { new: "Lead novo", waiting: "Esperando resposta" };

/**
 * Polls what needs a person and warns when something new shows up: pop-up on the screen, a sound,
 * and a browser notification when the CRM is in another tab or window. The first read only sets the
 * baseline, so opening the CRM does not ring for what was already there.
 */
export function useTeamAlerts(onChange?: () => void) {
  const router = useRouter();
  const [data, setData] = useState<TeamAlerts | null>(null);
  const [toasts, setToasts] = useState<Alert[]>([]);
  const sound = useSyncExternalStore(subscribePrefs, soundIsOn, () => true);
  const permission = useSyncExternalStore(subscribePrefs, notificationPermission, (): Permission => "unsupported");
  const known = useRef<Set<string> | null>(null);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });

  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    return () => window.removeEventListener("pointerdown", unlockAudio);
  }, []);

  const dismiss = useCallback((key: string) => setToasts((t) => t.filter((x) => x.key !== key)), []);

  const announce = useCallback(
    (fresh: Alert[]) => {
      setToasts((t) => [...fresh.slice(0, 3), ...t].slice(0, 4));
      for (const a of fresh.slice(0, 3)) setTimeout(() => dismiss(a.key), 20_000);
      if (!claim(fresh.map((a) => a.key))) return;
      if (soundIsOn()) ding();
      if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        for (const a of fresh.slice(0, 3)) {
          const n = new Notification(`${TITLE[a.kind]}: ${a.name}`, { body: a.text, tag: a.key });
          n.onclick = () => {
            window.focus();
            router.push(`/leads/${a.leadId}`);
          };
        }
      }
    },
    [dismiss, router],
  );

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts", { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as TeamAlerts;
      setData(next);
      const fresh = known.current ? next.items.filter((i) => !known.current!.has(i.key)) : [];
      known.current = new Set(next.items.map((i) => i.key));
      if (fresh.length) {
        announce(fresh);
        changed.current?.();
      }
    } catch {
      // Offline for a moment: the next round catches up
    }
  }, [announce]);

  useEffect(() => {
    const first = setTimeout(poll, 0);
    const timer = setInterval(poll, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  /** First click asks the browser for notifications and plays the sound once; later clicks mute or unmute. */
  const toggle = useCallback(async () => {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
      setSoundPref(true);
      ding();
      return;
    }
    const on = !soundIsOn();
    setSoundPref(on);
    if (on) ding();
  }, []);

  return { data, toasts, dismiss, sound, permission, toggle };
}

export function Badge({ count, title }: { count: number; title?: string }) {
  if (!count) return null;
  return (
    <span
      title={title}
      className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-brand"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function AlertBell({ sound, permission, onClick }: { sound: boolean; permission: Permission; onClick: () => void }) {
  const ask = permission === "default";
  const Icon = ask ? BellRing : sound ? Bell : BellOff;
  const title = ask
    ? "Ativar avisos: o navegador pede permissão para mostrar notificações, e o CRM toca um som quando chega lead novo ou mensagem esperando resposta."
    : sound
      ? "Som dos avisos ligado. Clique para silenciar."
      : "Som dos avisos desligado. Clique para ligar.";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="relative flex w-full flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[11px] font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
    >
      <span className="relative">
        <Icon size={20} strokeWidth={1.8} />
        {ask && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 animate-ping rounded-full bg-amber-300" />}
      </span>
      {ask ? "Ativar avisos" : sound ? "Som ligado" : "Sem som"}
    </button>
  );
}

export function AlertToasts({ toasts, dismiss }: { toasts: Alert[]; dismiss: (key: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((a) => {
        const Icon = a.kind === "new" ? UserPlus : MessageCircle;
        return (
          <div key={a.key} className="flex gap-3 rounded-2xl border border-red-200 bg-white p-3 shadow-xl ring-1 ring-black/5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-600 text-white">
              <Icon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-red-600">{TITLE[a.kind]}</div>
              <div className="truncate text-sm font-semibold text-slate-900">{a.name}</div>
              <div className="line-clamp-2 text-xs text-slate-600">{a.text}</div>
              <Link
                href={`/leads/${a.leadId}`}
                onClick={() => dismiss(a.key)}
                className="mt-1.5 inline-block rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-dark"
              >
                Abrir
              </Link>
            </div>
            <button type="button" onClick={() => dismiss(a.key)} className="self-start text-slate-400 hover:text-slate-600" title="Fechar">
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
