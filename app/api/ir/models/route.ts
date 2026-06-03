import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// List catalog models, filtered by ?brand=<id> and/or ?q=<model name> and/or
// ?kind=<device_kind>. Returns the brand name inline for display.
export async function GET(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const brand = params.get("brand");
  const q = params.get("q")?.trim();
  const kind = params.get("kind");

  if (!brand && !q) {
    return NextResponse.json({ error: "provide ?brand= or ?q=" }, { status: 400 });
  }

  let query = supabase
    .from("ir_models")
    .select("id, name, device_kind, ac_vendor, brand:ir_brands!inner(id, name)")
    .order("name", { ascending: true })
    .limit(500);
  if (brand) query = query.eq("brand_id", brand);
  if (kind) query = query.eq("device_kind", kind);
  if (q) query = query.ilike("name", `%${q}%`);

  const { data, error } = await query;
  if (error) {
    console.error("[ir/models]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const models = (data ?? []).map((m) => {
    const brandRel = m.brand as unknown as { id: string; name: string } | { id: string; name: string }[];
    const b = Array.isArray(brandRel) ? brandRel[0] : brandRel;
    return {
      id: m.id,
      name: m.name,
      device_kind: m.device_kind,
      ac_vendor: m.ac_vendor,
      brand: b ? { id: b.id, name: b.name } : null,
    };
  });
  return NextResponse.json({ models });
}
