import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";
import { isAdminUser } from "@/lib/admin";
import { ThemeToggle } from "../theme-toggle";

// Admin-only console. The product UI — sensor dashboards, trends, claiming —
// lives in the Serpis IoT mobile app; the backend exists only for firmware
// uploads, which are admin-gated. Non-admins who reach here get a plain notice
// instead of the old device view.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = auth();
  if (!userId) redirect("/sign-in");
  const user = await currentUser();
  const admin = isAdminUser(userId);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <Link href="/dashboard/firmware">Serpis IoT</Link>
        </div>
        <div className="right">
          <span className="row-meta">{user?.primaryEmailAddress?.emailAddress}</span>
          <ThemeToggle />
          <UserButton afterSignOutUrl="/sign-in" />
        </div>
      </header>
      <div className="shell">
        <section className="detail">
          {admin ? (
            children
          ) : (
            <div className="empty">
              <h1 style={{ fontSize: 20, marginTop: 0 }}>Not authorized</h1>
              <p>
                This console is for administrators only. Manage your sensors in the
                Serpis IoT mobile app.
              </p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
