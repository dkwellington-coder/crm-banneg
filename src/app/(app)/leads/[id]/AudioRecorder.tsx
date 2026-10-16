"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, Send, Square, Trash2 } from "lucide-react";
import { btnCls, btnGhostCls } from "@/components/ui";

// Firefox records Ogg (what WhatsApp plays as a voice message), Chrome WebM (the CRM turns it into Ogg), Safari MP4
const TYPES = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"];
const MAX_SECONDS = 300;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function AudioRecorder({ leadId, windowOpen }: { leadId: string; windowOpen: boolean }) {
  const router = useRouter();
  const recorder = useRef<MediaRecorder | null>(null);
  const [state, setState] = useState<"idle" | "recording" | "ready" | "sending">("idle");
  const [seconds, setSeconds] = useState(0);
  const [audio, setAudio] = useState<{ blob: Blob; url: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (state !== "recording") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  useEffect(() => {
    if (state === "recording" && seconds >= MAX_SECONDS) recorder.current?.stop();
  }, [state, seconds]);

  useEffect(() => {
    if (!audio) return;
    return () => URL.revokeObjectURL(audio.url);
  }, [audio]);

  async function start() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 32_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
        setAudio({ blob, url: URL.createObjectURL(blob) });
        setState("ready");
      };
      recorder.current = rec;
      setSeconds(0);
      rec.start();
      setState("recording");
    } catch {
      setError("O navegador não liberou o microfone. Permita o microfone para este site e tente de novo.");
    }
  }

  async function send() {
    if (!audio) return;
    setState("sending");
    const form = new FormData();
    form.append("audio", audio.blob, "audio");
    const res = await fetch(`/api/leads/${leadId}/audio`, { method: "POST", body: form });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(json.error ?? "Não deu para enviar o áudio.");
      setState("ready");
      return;
    }
    setAudio(null);
    setState("idle");
    router.refresh();
  }

  if (!windowOpen)
    return (
      <span className="text-xs text-slate-400" title="O áudio só vai com a janela de 24 h aberta: mande um texto e grave quando o lead responder.">
        <Mic size={16} className="inline" /> áudio depois que o lead responder
      </span>
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {state === "idle" && (
        <button type="button" onClick={start} className={btnGhostCls} title="Gravar áudio">
          <Mic size={16} /> Gravar áudio
        </button>
      )}
      {state === "recording" && (
        <button type="button" onClick={() => recorder.current?.stop()} className={`${btnGhostCls} text-red-600!`}>
          <Square size={14} className="fill-current" /> Parar · {clock(seconds)}
        </button>
      )}
      {(state === "ready" || state === "sending") && audio && (
        <>
          <audio src={audio.url} controls className="h-9 w-56" />
          <button
            type="button"
            onClick={() => {
              setAudio(null);
              setState("idle");
            }}
            className={btnGhostCls}
            disabled={state === "sending"}
            title="Descartar"
          >
            <Trash2 size={16} />
          </button>
          <button type="button" onClick={send} className={btnCls} disabled={state === "sending"}>
            <Send size={16} /> {state === "sending" ? "Enviando…" : "Enviar áudio"}
          </button>
        </>
      )}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
