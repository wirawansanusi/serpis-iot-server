import { redirect } from "next/navigation";

// The backend is firmware-only now; send the dashboard root straight to the
// firmware console. Access control (admin) is enforced by the layout and by the
// firmware page itself.
export default function DashboardIndex() {
  redirect("/dashboard/firmware");
}
