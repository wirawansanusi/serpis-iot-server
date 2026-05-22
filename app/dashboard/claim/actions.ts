"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

export async function claimDevice(formData: FormData): Promise<void> {
  const { userId } = auth();
  if (!userId) redirect("/sign-in");

  const rawMac = String(formData.get("mac") ?? "").trim().toUpperCase().replace(/-/g, ":");
  if (!MAC_RE.test(rawMac)) {
    redirect(`/dashboard/claim?error=${encodeURIComponent("Enter a valid MAC like AA:BB:CC:DD:EE:FF")}`);
  }

  // Look up the device — service-role client sees all rows regardless of owner.
  const { data: device, error: findErr } = await supabase
    .from("devices")
    .select("id, owner_user_id")
    .eq("mac", rawMac)
    .maybeSingle();

  if (findErr) {
    redirect(`/dashboard/claim?error=${encodeURIComponent(findErr.message)}`);
  }
  if (!device) {
    redirect(`/dashboard/claim?error=${encodeURIComponent("Device not found. Power it on and wait for its first reading, then try again.")}`);
  }
  if (device.owner_user_id && device.owner_user_id !== userId) {
    redirect(`/dashboard/claim?error=${encodeURIComponent("This device is already claimed by another account.")}`);
  }
  if (device.owner_user_id === userId) {
    redirect(`/dashboard/${device.id}`);
  }

  const { error: updErr } = await supabase
    .from("devices")
    .update({ owner_user_id: userId })
    .eq("id", device.id);
  if (updErr) {
    redirect(`/dashboard/claim?error=${encodeURIComponent(updErr.message)}`);
  }

  revalidatePath("/dashboard");
  redirect(`/dashboard/${device.id}`);
}
