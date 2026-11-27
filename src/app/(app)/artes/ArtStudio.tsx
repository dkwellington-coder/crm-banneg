"use client";

import { useEffect, useState } from "react";
import { Download, ImagePlus, Loader2, Sparkles } from "lucide-react";
import { ART_MODELS, LEGAL_LINES, type ArtModel } from "@/lib/art-form";
import { Card, btnCls, btnGhostCls, inputCls } from "@/components/ui";

type Fields = Record<string, string>;

// A worked example for each model, so the first art already looks like the approved ones
const EXAMPLES: Record<ArtModel, Fields> = {
  simples: {
    chamada: "Consórcio linha aquática",
    titulo: "Seu jet ski com *meia parcela* até a contemplação",
    texto: "",
    selos: "Consulte disponibilidade de vagas\nConsulte outras condições",
    rodape: LEGAL_LINES[0].text,
  },
  // Values from the Guia de Consórcios (4.2, the simulation already used in the arts): replace with the current table
  tabela: {
    chamada: "Carta de serviços",
    titulo: "Sua *bike* sem juros, no seu ritmo",
    tabela: "Carta | Prazo | Parcela\nR$ 14 mil | 66 meses | R$ 270,62\nR$ 30 mil | 84 meses | R$ 461,01",
    selos: "Consulte disponibilidade de vagas\nConsulte outras condições",
    rodape: LEGAL_LINES[2].text,
  },
  numeros: {
    chamada: "Crédito agro",
    titulo: "Levante *R$ 1,4 milhão* com a sua fazenda",
    numeros: "R$ 1,4 mi | Crédito\nR$ 3,2 mi | Garantia\nR$ 24 mil | Parcelas iniciais",
    botao: "Me chame agora",
    rodape: LEGAL_LINES[4].text,
  },
  passos: {
    chamada: "Capital de giro",
    titulo: "Levante *capital de giro* com o seu imóvel",
    passos: "Você compra o consórcio\n* Pagamos seu lance | Nós damos o lance e te contemplamos\nLiberamos o crédito pra você",
    botao: "Agende uma consultoria",
    rodape: "Sujeito à análise de crédito e às regras do grupo.",
  },
};

const label = "block text-xs font-semibold text-slate-600";

/** Shrinks a big photo in the browser (longest side 2000 px, JPEG), so any phone picture fits the upload. */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Não consegui ler a foto."))), "image/jpeg", 0.9));
}

export function ArtStudio() {
  const [model, setModel] = useState<ArtModel>("tabela");
  const [f, setF] = useState<Fields>({ formato: "post", tema: "azul", ...EXAMPLES.tabela });
  const [photo, setPhoto] = useState<File | null>(null);
  const [material, setMaterial] = useState("");
  const [png, setPng] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => void (png && URL.revokeObjectURL(png)), [png]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const pickModel = (m: ArtModel) => {
    setModel(m);
    setF((p) => ({ formato: p.formato, tema: p.tema, ...EXAMPLES[m] }));
  };

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      Object.entries({ ...f, modelo: model }).forEach(([k, v]) => body.set(k, v ?? ""));
      if (photo) body.set("foto", await shrink(photo), "foto.jpg");
      else if (material) body.set("foto_material", material);
      const res = await fetch("/api/artes", { method: "POST", body });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Erro ${res.status}`);
      setPng(URL.createObjectURL(await res.blob()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const fileName = `Banneg - ${(f.titulo ?? "arte").replace(/\*/g, "").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 40).trim() || "arte"}.png`;

  return (
    <div className="grid gap-4 px-4 pb-8 md:px-6 xl:grid-cols-[1fr_minmax(320px,460px)]">
      <Card>
        <form onSubmit={generate} className="space-y-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {ART_MODELS.map((m) => (
              <button
                type="button"
                key={m.key}
                onClick={() => pickModel(m.key)}
                className={`rounded-xl border p-3 text-left transition ${model === m.key ? "border-brand bg-brand-soft ring-2 ring-brand/20" : "border-slate-200 hover:border-brand"}`}
              >
                <span className="block text-sm font-semibold text-slate-800">{m.label}</span>
                <span className="block text-xs text-slate-500">{m.hint}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>
              Formato
              <select value={f.formato} onChange={set("formato")} className={`${inputCls} mt-1`}>
                <option value="post">Feed 1080 x 1350</option>
                <option value="quadrado">Quadrado 1080 x 1080</option>
                <option value="story">Story / Reels 1080 x 1920</option>
              </select>
            </label>
            <label className={label}>
              Fundo
              <select value={f.tema} onChange={set("tema")} className={`${inputCls} mt-1`}>
                <option value="azul">Azul abissal (padrão)</option>
                <option value="claro">Claro</option>
                <option value="dourado">Dourado</option>
              </select>
            </label>
          </div>

          <label className={label}>
            Chapéu (linha pequena acima do título)
            <input value={f.chamada ?? ""} onChange={set("chamada")} className={`${inputCls} mt-1`} placeholder="CONSÓRCIO LINHA AQUÁTICA" />
          </label>
          <label className={label}>
            Título · a palavra-chave entre *asteriscos* sai em dourado itálico
            <input required value={f.titulo ?? ""} onChange={set("titulo")} className={`${inputCls} mt-1`} />
          </label>
          <label className={label}>
            Texto de apoio (opcional)
            <input value={f.texto ?? ""} onChange={set("texto")} className={`${inputCls} mt-1`} />
          </label>

          {model === "tabela" && (
            <label className={label}>
              Tabela · primeira linha é o cabeçalho, separe as colunas com |
              <textarea rows={4} value={f.tabela ?? ""} onChange={set("tabela")} className={`${inputCls} mt-1 font-mono`} />
            </label>
          )}
          {model === "numeros" && (
            <label className={label}>
              Números · um por linha: valor | rótulo
              <textarea rows={4} value={f.numeros ?? ""} onChange={set("numeros")} className={`${inputCls} mt-1 font-mono`} />
            </label>
          )}
          {model === "passos" && (
            <label className={label}>
              Passos · um por linha: título | texto. Comece com * o passo principal
              <textarea rows={3} value={f.passos ?? ""} onChange={set("passos")} className={`${inputCls} mt-1 font-mono`} />
            </label>
          )}
          {model === "simples" && (
            <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
              <label className={label}>
                Destaque (opcional)
                <input value={f.destaque ?? ""} onChange={set("destaque")} className={`${inputCls} mt-1`} placeholder="R$ 19.900" />
              </label>
              <label className={label}>
                O que é o destaque
                <input value={f.destaque_legenda ?? ""} onChange={set("destaque_legenda")} className={`${inputCls} mt-1`} placeholder="taxa de franquia" />
              </label>
            </div>
          )}

          <label className={label}>
            Selos com check · um por linha (opcional)
            <textarea rows={2} value={f.selos ?? ""} onChange={set("selos")} className={`${inputCls} mt-1`} />
          </label>
          <label className={label}>
            Botão dourado (opcional) · telefone só quando o Wellington autorizar
            <input value={f.botao ?? ""} onChange={set("botao")} className={`${inputCls} mt-1`} placeholder="Me chame agora" />
          </label>
          <label className={label}>
            Linha legal no rodapé
            <select value={LEGAL_LINES.some((l) => l.text === f.rodape) ? f.rodape : ""} onChange={set("rodape")} className={`${inputCls} mt-1`}>
              <option value="">Outro texto (escreva abaixo)</option>
              {LEGAL_LINES.map((l) => (
                <option key={l.label} value={l.text}>
                  {l.label}
                </option>
              ))}
            </select>
            <input value={f.rodape ?? ""} onChange={set("rodape")} className={`${inputCls} mt-2`} />
          </label>

          <div className="space-y-2">
            <p className={label}>Foto real de fundo (opcional)</p>
            <div className="flex flex-wrap items-center gap-2">
              <label className={`${btnGhostCls} cursor-pointer`}>
                <ImagePlus size={16} /> {photo ? photo.name.slice(0, 24) : "Escolher foto"}
                <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => (setPhoto(e.target.files?.[0] ?? null), setMaterial(""))} />
              </label>
              <select value={material} onChange={(e) => (setMaterial(e.target.value), setPhoto(null))} className={`${inputCls} w-auto!`} aria-label="Foto do CRM">
                <option value="">ou uma foto do CRM</option>
                <option value="fachada-loja.jpg">Fachada da loja</option>
                <option value="wellington.jpg">Wellington</option>
              </select>
              {(photo || material) && (
                <button type="button" onClick={() => (setPhoto(null), setMaterial(""))} className="text-xs text-slate-500 underline">
                  sem foto
                </button>
              )}
            </div>
          </div>

          <button className={btnCls} disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Gerar arte
          </button>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </form>
      </Card>

      <Card className="space-y-3 self-start xl:sticky xl:top-4">
        {png ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={png} alt="Arte gerada" className="w-full rounded-lg shadow-sm" />
            <a href={png} download={fileName} className={`${btnCls} w-full`}>
              <Download size={16} /> Baixar PNG
            </a>
          </>
        ) : (
          <div className="flex aspect-[4/5] items-center justify-center rounded-lg border-2 border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
            A arte aparece aqui. Clique em Gerar arte.
          </div>
        )}
        <p className="text-xs text-slate-500">Antes de publicar: valores conferidos com a tabela atual, nenhuma promessa de contemplação, aprovação ou renda.</p>
      </Card>
    </div>
  );
}
