import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function DashboardIndex() {
  const { userId } = auth();
  if (!userId) redirect("/sign-in");

  const { data: devices } = await supabase
    .from("devices")
    .select("id")
    .eq("owner_user_id", userId)
    .order("last_seen", { ascending: false })
    .limit(1);

  if (devices && devices.length > 0) {
    redirect(`/dashboard/${devices[0].id}`);
  }

  return (
    <div className="empty">
      <h1 style={{ fontSize: 20, marginTop: 0 }}>No devices yet</h1>
      <p>Power on a Humid device and complete the captive-portal setup.</p>
      <p>
        Once it&apos;s sent at least one reading,{" "}
        <Link href="/dashboard/claim">claim it</Link> by entering its MAC.
      </p>
    </div>
  );
}
