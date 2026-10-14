import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <div className="mb-6">
          <div className="text-2xl font-black tracking-widest text-brand">BANNEG /</div>
          <div className="text-xs font-semibold tracking-widest text-slate-500">CRM DE EXPANSÃO</div>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
