import { NextRequest, NextResponse } from "next/server";
import { authorizeMqtt, hookSecretOk } from "@/lib/mqtt-auth";

export const dynamic = "force-dynamic";

// EMQX HTTP authorization hook. EMQX POSTs { username, topic, action } on each
// publish/subscribe by a non-superuser; we allow only the device's own topics.
// (The backend superuser is granted is_superuser at authn and never reaches here.)
export async function POST(req: NextRequest) {
  if (!hookSecretOk(req.headers.get("x-auth-hook-secret"))) {
    return NextResponse.json({ result: "deny" }, { status: 403 });
  }

  let body: { username?: unknown; topic?: unknown; action?: unknown };
  try {
    body = (await req.json()) as { username?: unknown; topic?: unknown; action?: unknown };
  } catch {
    return NextResponse.json({ result: "deny" }, { status: 200 });
  }

  const username = typeof body.username === "string" ? body.username : "";
  const topic = typeof body.topic === "string" ? body.topic : "";
  const action = body.action === "publish" || body.action === "subscribe" ? body.action : null;
  if (!action) return NextResponse.json({ result: "deny" }, { status: 200 });

  return NextResponse.json(
    { result: authorizeMqtt(username, topic, action) ? "allow" : "deny" },
    { status: 200 },
  );
}
