import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function tokenOk(provided: string | null): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export async function POST(req: NextRequest) {
  if (!tokenOk(req.headers.get("x-device-token"))) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "missing body" }, { status: 400 });
  }
  const { device_id, temp_c, humidity, uptime_ms } = body as Record<string, unknown>;

  if (typeof device_id !== "string" || device_id.length === 0 || device_id.length > 64) {
    return NextResponse.json({ error: "invalid device_id" }, { status: 400 });
  }
  if (!isFiniteNumber(temp_c) || !isFiniteNumber(humidity)) {
    return NextResponse.json({ error: "temp_c and humidity must be numbers" }, { status: 400 });
  }
  if (uptime_ms !== undefined && !isFiniteNumber(uptime_ms)) {
    return NextResponse.json({ error: "uptime_ms must be a number if present" }, { status: 400 });
  }

  const { error } = await supabase.rpc("ingest_reading", {
    p_mac: device_id,
    p_temp: temp_c,
    p_humidity: humidity,
    p_uptime: uptime_ms ?? null,
  });

  if (error) {
    console.error("[ingest] rpc error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
