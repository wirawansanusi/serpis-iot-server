import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Per-phone notification delivery. A subscription = "this install (push token)
// wants alerts for this sensor." The shared band/cadence lives in
// device_notification_settings; this only controls who-gets-pinged.
//
// POST   { token } -> subscribe this phone to the device.
// DELETE { token } -> unsubscribe this phone from the device.
//
// Both verify the device is owned by the caller AND the push token is registered
// to the caller, so one user can't wire alerts to another user's phone.

function isExpoToken(v: unknown): v is string {
  return typeof v === "string" && /^Expo(nent)?PushToken\[.+\]$/.test(v);
}

async function authorize(
  userId: string,
  deviceId: string,
  token: unknown,
): Promise<{ token: string } | { error: string; status: number }> {
  if (!isExpoToken(token)) return { error: "invalid Expo push token", status: 400 };

  const { data: device } = await supabase
    .from("devices")
    .select("id")
    .eq("id", deviceId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (!device) return { error: "device not found", status: 404 };

  const { data: pushToken } = await supabase
    .from("push_tokens")
    .select("token")
    .eq("token", token)
    .eq("user_id", userId)
    .maybeSingle();
  if (!pushToken) return { error: "push token not registered to this user", status: 404 };

  return { token };
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const result = await authorize(userId, params.id, (body as Record<string, unknown>)?.token);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

  const { error } = await supabase
    .from("device_push_subscriptions")
    .upsert({ device_id: params.id, token: result.token }, { onConflict: "device_id,token" });
  if (error) {
    console.error("[push-subscription POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ enabled: true });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const result = await authorize(userId, params.id, (body as Record<string, unknown>)?.token);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

  const { error } = await supabase
    .from("device_push_subscriptions")
    .delete()
    .eq("device_id", params.id)
    .eq("token", result.token);
  if (error) {
    console.error("[push-subscription DELETE]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ enabled: false });
}
