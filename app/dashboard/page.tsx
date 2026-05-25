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
      <p>Power on a Humid device and complete the captive-portal Wi-Fi setup.</p>
      <p>
        Then <Link href="/dashboard/claim">add it</Link> from the Humid mobile app,
        which pairs over Bluetooth to confirm it&apos;s yours.
      </p>
    </div>
  );
}
