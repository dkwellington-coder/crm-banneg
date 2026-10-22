import type { Metadata, Viewport } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";

// The BANNEG brand font
const montserrat = Montserrat({ subsets: ["latin"], variable: "--font-montserrat", display: "swap" });

export const metadata: Metadata = {
  title: "BANNEG CRM",
  description: "CRM de expansão de franquias do Banneg",
};

// viewport-fit=cover lets the phone's bottom bar sit above the iPhone's home line (safe-area inset)
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#f7f6f2" };

// Runs before the page paints, so a dark-mode user never sees a flash of the light theme
const THEME_SCRIPT = `try{if(localStorage.getItem("crm_theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${montserrat.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
