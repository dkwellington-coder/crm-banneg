import { markCofOpened } from "@/lib/cof";

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** The invisible image of the COF e-mail: loading it means the lead opened the e-mail. */
export async function GET(_request: Request, ctx: RouteContext<"/api/cof/[token]/aberto.gif">) {
  const { token } = await ctx.params;
  await markCofOpened(token, "email").catch(() => undefined);
  return new Response(PIXEL, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" } });
}
