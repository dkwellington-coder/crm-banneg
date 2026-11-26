import { ImageResponse } from "next/og";
import { CRM_URL } from "./calendar";

/**
 * Jessica's arts (Wellington, 2026-11-26: "gerar as artes, e ideias"): posts and stories in Banneg's look (azul abissal
 * #000314, dourado imperial #e2b124, Montserrat, the monogram), drawn by the CRM itself from what she writes and sent
 * as a picture on WhatsApp. No paid tool: the layout is fixed, the AI chooses the words, the theme and the photo.
 */

export const ART_FORMATS = { post: [1080, 1350], quadrado: [1080, 1080], story: [1080, 1920] } as const;
export const ART_THEMES = ["azul", "claro", "dourado"] as const;
export type ArtFormat = keyof typeof ART_FORMATS;
export type ArtTheme = (typeof ART_THEMES)[number];

export type ArtInput = {
  formato?: string;
  tema?: string;
  chamada?: string; // small line above the title ("FRANQUIA HOME OFFICE")
  titulo: string;
  texto?: string;
  destaque?: string; // a big number or offer ("R$ 19.900")
  destaque_legenda?: string; // what the number is ("taxa de franquia")
  itens?: string[];
  rodape?: string;
};

export type ArtAssets = { fonts: { weight: 400 | 700 | 800; data: ArrayBuffer }[]; logoGold: string; logoBlue: string; photo?: string | null };

const NAVY = "#000314";
const GOLD = "#e2b124";
const CREAM = "#f7f6f2";

const THEMES: Record<ArtTheme, { bg: string; ink: string; soft: string; accent: string; accentInk: string; logo: "gold" | "blue" }> = {
  azul: { bg: NAVY, ink: "#ffffff", soft: "#c9cbd6", accent: GOLD, accentInk: NAVY, logo: "gold" },
  claro: { bg: CREAM, ink: NAVY, soft: "#4a4f66", accent: GOLD, accentInk: NAVY, logo: "blue" },
  dourado: { bg: GOLD, ink: NAVY, soft: "#2c2a20", accent: NAVY, accentInk: GOLD, logo: "blue" },
};

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** What the AI asked, kept within what fits on the art. */
export function normalizeArt(input: ArtInput) {
  const formato = (Object.keys(ART_FORMATS) as ArtFormat[]).includes(input.formato as ArtFormat) ? (input.formato as ArtFormat) : "post";
  const tema = ART_THEMES.includes(input.tema as ArtTheme) ? (input.tema as ArtTheme) : "azul";
  const titulo = clean(input.titulo, 120);
  if (!titulo) throw new Error("A arte precisa de um título.");
  return {
    formato,
    tema,
    chamada: clean(input.chamada, 50).toUpperCase(),
    titulo,
    texto: clean(input.texto, 280),
    destaque: clean(input.destaque, 24),
    destaqueLegenda: clean(input.destaque_legenda, 60),
    itens: (Array.isArray(input.itens) ? input.itens : []).map((i) => clean(i, 80)).filter(Boolean).slice(0, 5),
    rodape: clean(input.rodape, 70) || "banneg.com.br",
  };
}

/** Bigger letters for short titles, smaller for long ones, so the title always fits. */
export function titleSize(title: string, width: number, tall: boolean) {
  const base = width / 1080;
  const n = title.length;
  const size = n <= 22 ? 104 : n <= 40 ? 88 : n <= 60 ? 74 : n <= 85 ? 62 : 52;
  return Math.round(size * base * (tall ? 1.08 : 1));
}

async function fetchBuffer(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Não consegui baixar ${url.split("/").pop()} (HTTP ${res.status}).`);
  return res.arrayBuffer();
}

const dataUrl = (buf: ArrayBuffer | Buffer, mime: string) => `data:${mime};base64,${Buffer.from(buf as ArrayBuffer).toString("base64")}`;

/** The fonts and the monograms, from the CRM's own public folder. */
export async function loadArtAssets(): Promise<ArtAssets> {
  const base = `${CRM_URL}/brand`;
  const [f400, f700, f800, gold, blue] = await Promise.all([
    fetchBuffer(`${base}/fonts/montserrat-400.woff`),
    fetchBuffer(`${base}/fonts/montserrat-700.woff`),
    fetchBuffer(`${base}/fonts/montserrat-800.woff`),
    fetchBuffer(`${base}/monograma-dourado.png`),
    fetchBuffer(`${base}/monograma-azul.png`),
  ]);
  return {
    fonts: [
      { weight: 400, data: f400 },
      { weight: 700, data: f700 },
      { weight: 800, data: f800 },
    ],
    logoGold: dataUrl(gold, "image/png"),
    logoBlue: dataUrl(blue, "image/png"),
  };
}

export function photoDataUrl(data: Buffer, mime: string) {
  if (!/^image\/(jpeg|png)$/.test(mime)) throw new Error("A foto da arte precisa ser JPG ou PNG.");
  if (data.length > 8 * 1024 * 1024) throw new Error("Foto grande demais para a arte (mais de 8 MB).");
  return dataUrl(data, mime);
}

/** The art as a PNG. */
export async function renderArt(input: ArtInput, assets: ArtAssets): Promise<Buffer> {
  const a = normalizeArt(input);
  const [width, height] = ART_FORMATS[a.formato];
  const t = THEMES[a.tema];
  const s = width / 1080;
  const tall = a.formato === "story";
  const pad = Math.round(84 * s);
  const photo = assets.photo ?? null;
  const logo = photo ? assets.logoGold : t.logo === "gold" ? assets.logoGold : assets.logoBlue;
  // With a photo, the text sits on a dark band over it and the colors follow the dark theme
  const ink = photo ? "#ffffff" : t.ink;
  const soft = photo ? "#e4e5ec" : t.soft;
  const accent = photo ? GOLD : t.accent;
  const accentInk = photo ? NAVY : t.accentInk;

  const element = (
    <div style={{ width, height, display: "flex", flexDirection: "column", background: t.bg, fontFamily: "Montserrat", position: "relative" }}>
      {photo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo} alt="" width={width} height={height} style={{ position: "absolute", top: 0, left: 0, width, height, objectFit: "cover" }} />
      )}
      {photo && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width,
            height,
            display: "flex",
            backgroundImage: "linear-gradient(180deg, rgba(0,3,20,0.35) 0%, rgba(0,3,20,0.55) 40%, rgba(0,3,20,0.94) 75%, rgba(0,3,20,0.98) 100%)",
          }}
        />
      )}
      {/* Thin gold line on top, the brand's signature */}
      <div style={{ display: "flex", width, height: Math.round(14 * s), background: accent }} />
      <div
        style={{ display: "flex", flexDirection: "column", flex: 1, padding: `${Math.round(64 * s)}px ${pad}px ${pad}px`, justifyContent: photo ? "flex-start" : "space-between", gap: photo ? Math.round(56 * s) : 0 }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} alt="" width={Math.round(150 * s)} height={Math.round(77 * s)} style={{ width: Math.round(150 * s), height: Math.round(77 * s) }} />
          <div style={{ display: "flex", fontSize: Math.round(24 * s), letterSpacing: 6 * s, fontWeight: 700, color: accent }}>BANNEG</div>
        </div>
        {/* Over a photo the words go down to the dark band, under the picture's subject */}
        <div style={{ display: "flex", flexDirection: "column", gap: Math.round(30 * s), marginTop: photo ? "auto" : 0 }}>
          {a.chamada && <div style={{ display: "flex", fontSize: Math.round(30 * s), fontWeight: 700, letterSpacing: 4 * s, color: accent }}>{a.chamada}</div>}
          <div style={{ display: "flex", fontSize: titleSize(a.titulo, width, tall), fontWeight: 800, lineHeight: 1.06, color: ink, letterSpacing: -1.5 * s }}>{a.titulo}</div>
          {a.texto && <div style={{ display: "flex", fontSize: Math.round(38 * s), fontWeight: 400, lineHeight: 1.4, color: soft }}>{a.texto}</div>}
          {a.itens.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: Math.round(16 * s) }}>
              {a.itens.map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: Math.round(20 * s) }}>
                  <div style={{ display: "flex", width: Math.round(16 * s), height: Math.round(16 * s), borderRadius: 99, background: accent }} />
                  <div style={{ display: "flex", fontSize: Math.round(36 * s), fontWeight: 700, color: ink }}>{item}</div>
                </div>
              ))}
            </div>
          )}
          {a.destaque && (
            <div style={{ display: "flex", alignItems: "center", gap: Math.round(28 * s), marginTop: Math.round(8 * s) }}>
              <div
                style={{
                  display: "flex",
                  padding: `${Math.round(18 * s)}px ${Math.round(34 * s)}px`,
                  borderRadius: Math.round(22 * s),
                  background: accent,
                  color: accentInk,
                  fontSize: Math.round(64 * s),
                  fontWeight: 800,
                }}
              >
                {a.destaque}
              </div>
              {a.destaqueLegenda && <div style={{ display: "flex", flex: 1, fontSize: Math.round(32 * s), fontWeight: 700, color: ink, lineHeight: 1.25 }}>{a.destaqueLegenda}</div>}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(22 * s) }}>
          <div style={{ display: "flex", width: Math.round(60 * s), height: Math.round(4 * s), background: accent }} />
          <div style={{ display: "flex", fontSize: Math.round(28 * s), fontWeight: 700, color: ink }}>{a.rodape}</div>
        </div>
      </div>
    </div>
  );

  const res = new ImageResponse(element, {
    width,
    height,
    fonts: assets.fonts.map((f) => ({ name: "Montserrat", data: f.data, weight: f.weight, style: "normal" as const })),
  });
  return Buffer.from(await res.arrayBuffer());
}

export const COLLAGE_LAYOUTS = ["lado_a_lado", "vertical", "grade"] as const;
export type CollageLayout = (typeof COLLAGE_LAYOUTS)[number];

/** How the pictures sit: 2 side by side, stacked, or a grid (2x2, 3x3...) for the rest. */
export function collageGrid(n: number, layout: string) {
  if (layout === "vertical") return { cols: 1, rows: n };
  if (layout === "lado_a_lado" && n <= 3) return { cols: n, rows: 1 };
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  return { cols, rows: Math.ceil(n / cols) };
}

/**
 * A montage of pictures (2026-11-26, Wellington: "junção de imagens") in Banneg's frame: navy background, the gold line,
 * an optional title, the pictures in a grid and the monogram with the footer.
 */
export async function renderCollage(
  input: { fotos: string[]; layout?: string; formato?: string; titulo?: string; rodape?: string },
  assets: ArtAssets,
): Promise<Buffer> {
  const fotos = input.fotos.slice(0, 9);
  if (fotos.length < 2) throw new Error("A montagem precisa de pelo menos 2 imagens.");
  const formato = (Object.keys(ART_FORMATS) as ArtFormat[]).includes(input.formato as ArtFormat) ? (input.formato as ArtFormat) : "post";
  const [width, height] = ART_FORMATS[formato];
  const s = width / 1080;
  const pad = Math.round(48 * s);
  const gap = Math.round(16 * s);
  const titulo = clean(input.titulo, 80);
  const rodape = clean(input.rodape, 70) || "banneg.com.br";
  const { cols, rows } = collageGrid(fotos.length, input.layout ?? "grade");
  const headH = titulo ? Math.round(150 * s) : Math.round(40 * s);
  const footH = Math.round(110 * s);
  const top = Math.round(14 * s);
  const areaW = width - pad * 2;
  const areaH = height - top - headH - footH - pad;
  const cellW = Math.floor((areaW - gap * (cols - 1)) / cols);
  const cellH = Math.floor((areaH - gap * (rows - 1)) / rows);

  const element = (
    <div style={{ width, height, display: "flex", flexDirection: "column", background: NAVY, fontFamily: "Montserrat" }}>
      <div style={{ display: "flex", width, height: top, background: GOLD }} />
      <div style={{ display: "flex", height: headH, alignItems: "center", padding: `0 ${pad}px`, color: "#ffffff", fontSize: titleSize(titulo, width, false) * 0.62, fontWeight: 800, lineHeight: 1.1 }}>
        {titulo}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap, padding: `0 ${pad}px`, width, height: areaH }}>
        {fotos.map((src, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} src={src} alt="" width={cellW} height={cellH} style={{ width: cellW, height: cellH, objectFit: "cover", borderRadius: Math.round(18 * s) }} />
        ))}
      </div>
      <div style={{ display: "flex", height: footH, marginTop: pad, alignItems: "center", justifyContent: "space-between", padding: `0 ${pad}px` }}>
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(22 * s) }}>
          <div style={{ display: "flex", width: Math.round(60 * s), height: Math.round(4 * s), background: GOLD }} />
          <div style={{ display: "flex", fontSize: Math.round(28 * s), fontWeight: 700, color: "#ffffff" }}>{rodape}</div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={assets.logoGold} alt="" width={Math.round(117 * s)} height={Math.round(60 * s)} style={{ width: Math.round(117 * s), height: Math.round(60 * s) }} />
      </div>
    </div>
  );
  const res = new ImageResponse(element, {
    width,
    height,
    fonts: assets.fonts.map((f) => ({ name: "Montserrat", data: f.data, weight: f.weight, style: "normal" as const })),
  });
  return Buffer.from(await res.arrayBuffer());
}
