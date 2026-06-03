import { NextRequest, NextResponse } from "next/server";
import { authenticateMqtt, hookSecretOk } from "@/lib/mqtt-auth";

export const dynamic = "force-dynamic";

// EMQX HTTP authentication hook. EMQX POSTs { username, password } on every
// device CONNECT; we reply with the EMQX 5 contract { result, is_superuser }.
// Guarded by the shared secret EMQX sends in X-Auth-Hook-Secret.
export async function POST(req: NextRequest) {
  if (!hookSecretOk(req.headers.get("x-auth-hook-secret"))) {
    return NextResponse.json({ result: "deny" }, { status: 403 });
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = (await req.json()) as { username?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ result: "deny" }, { status: 200 });
  }

  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const res = await authenticateMqtt(username, password);

  return NextResponse.json(
    res.allow ? { result: "allow", is_superuser: res.superuser } : { result: "deny" },
    { status: 200 },
  );
}
