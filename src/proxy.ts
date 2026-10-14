import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only; every page and action still verifies the session against the database.
export function proxy(request: NextRequest) {
  if (!request.cookies.has("crm_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|api|_next|favicon.ico).*)"],
};
