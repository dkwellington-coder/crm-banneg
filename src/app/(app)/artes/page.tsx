import { Suspense } from "react";
import { requireArea } from "@/lib/access";
import { Loading, PageHeader } from "@/components/ui";
import { ArtStudio } from "./ArtStudio";

/**
 * Artes (Wellington, 2026-11-27): posts and stories in Banneg's approved look, made in the CRM itself. The models,
 * colors, fonts and legal lines come from the Guia de Marketing Banneg and are fixed; the person writes the words and
 * picks a real photo. Jessica uses the same models on WhatsApp.
 */
export default function ArtesPage() {
  return (
    <>
      <PageHeader title="Artes" subtitle="Posts e stories no padrão do Banneg: escolha o modelo, escreva e baixe a imagem." />
      <Suspense fallback={<Loading />}>
        <Artes />
      </Suspense>
    </>
  );
}

async function Artes() {
  await requireArea("artes");
  return <ArtStudio />;
}
