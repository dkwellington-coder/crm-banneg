import Image from "next/image";
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#000314] p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <div className="mb-7 flex items-center gap-4">
          <Image src="/brand/monograma-azul.png" alt="" width={56} height={29} priority className="dark:hidden" />
          <Image src="/brand/monograma-dourado.png" alt="" width={56} height={29} priority className="hidden dark:block" />
          <div>
            <div className="text-xl font-light tracking-[0.5em] text-slate-900">BANNEG</div>
            <div className="text-[11px] font-semibold tracking-[0.45em] text-gold-ink">CRM</div>
          </div>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
