import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// List IR catalog brands (with model counts), optionally filtered by ?q=.
// Any signed-in user can browse the shared catalog.
export async function GET(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const q = req.nextUrl.searchParams.get("q")?.trim();

  let query = supabase
    .from("ir_brands")
    .select("id, name, slug, ir_models(count)")
    .order("name", { ascending: true })
    .limit(1000);
  if (q) query = query.ilike("name", `%${q}%`);

  const { data, error } = await query;
  if (error) {
    console.error("[ir/brands]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const brands = (data ?? []).map((b) => {
    const counts = b.ir_models as unknown as { count: number }[] | null;
    return {
      id: b.id,
      name: b.name,
      slug: b.slug,
      model_count: Array.isArray(counts) && counts[0] ? counts[0].count : 0,
    };
  });
  return NextResponse.json({ brands });
}
