"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export async function renameDevice(formData: FormData): Promise<void> {
  const { userId } = auth();
  if (!userId) redirect("/sign-in");

  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("name") ?? "").trim();
  const name = raw.length > 0 ? raw.slice(0, 64) : null;
  if (!id) return;

  // Filter by owner_user_id so a user can only rename their own devices.
  const { error } = await supabase
    .from("devices")
    .update({ name })
    .eq("id", id)
    .eq("owner_user_id", userId);
  if (error) console.error("[renameDevice]", error);
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/${id}`);
}

export async function deleteDevice(formData: FormData): Promise<void> {
  const { userId } = auth();
  if (!userId) redirect("/sign-in");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // ON DELETE CASCADE in schema removes readings + rollups + events.
  const { error } = await supabase
    .from("devices")
    .delete()
    .eq("id", id)
    .eq("owner_user_id", userId);
  if (error) {
    console.error("[deleteDevice]", error);
    return;
  }
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
