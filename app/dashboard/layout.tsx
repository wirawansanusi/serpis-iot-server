import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";
import { Sidebar } from "./sidebar";
import { ThemeToggle } from "../theme-toggle";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = auth();
  if (!userId) redirect("/sign-in");
  const user = await currentUser();

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <Link href="/dashboard">Humid</Link>
        </div>
        <div className="right">
          <span className="row-meta">{user?.primaryEmailAddress?.emailAddress}</span>
          <ThemeToggle />
          <UserButton afterSignOutUrl="/sign-in" />
        </div>
      </header>
      <div className="shell">
        <Sidebar userId={userId} />
        <section className="detail">{children}</section>
      </div>
    </>
  );
}
