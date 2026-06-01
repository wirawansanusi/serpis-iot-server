import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Allowed upload cadences (minutes). MUST match the app picker
// (lib/reportInterval.ts) and the devices_report_interval_check DB constraint.
const ALLOWED = [5, 10, 15, 30, 60];

// Set how often a device uploads. Owner-scoped (the Clerk userId that claimed
// it). The device samples every 5 min regardless; this only batches uploads.
// The device adopts the new value on its next ingest check-in.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const minutes = (body as Record<string, unknown> | null)?.minutes;
  if (typeof minutes !== "number" || !ALLOWED.includes(minutes)) {
    return NextResponse.json({ error: `minutes must be one of ${ALLOWED.join(", ")}` }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("devices")
    .update({ report_interval_minutes: minutes })
    .eq("id", params.id)
    .eq("owner_user_id", userId)
    .select("id, report_interval_minutes")
    .maybeSingle();
  if (error) {
    console.error("[report-interval]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "device not found" }, { status: 404 });
  return NextResponse.json({ id: data.id, report_interval_minutes: data.report_interval_minutes });
}
