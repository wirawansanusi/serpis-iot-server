import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Expo push tokens look like ExponentPushToken[xxxx] or ExpoPushToken[xxxx].
function isExpoToken(v: unknown): v is string {
  return typeof v === "string" && /^Expo(nent)?PushToken\[.+\]$/.test(v);
}

// Register/refresh this install's Expo push token for the signed-in user. A
// token is globally unique to one install, so it's the primary key; re-POSTing
// just refreshes last_seen and re-owns it to the current user (re-login).
export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isExpoToken(b.token)) {
    return NextResponse.json({ error: "invalid Expo push token" }, { status: 400 });
  }
  const platform = b.platform === "ios" || b.platform === "android" ? b.platform : null;

  const { error } = await supabase.from("push_tokens").upsert(
    { token: b.token, user_id: userId, platform, last_seen_at: new Date().toISOString() },
    { onConflict: "token" },
  );
  if (error) {
    console.error("[push-tokens]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// Unregister on sign-out so a shared phone stops getting the old user's alerts.
export async function DELETE(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const token = (body as Record<string, unknown>)?.token;
  if (typeof token !== "string") {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }
  // Only delete a token the caller owns.
  const { error } = await supabase.from("push_tokens").delete().eq("token", token).eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
