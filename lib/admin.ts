// Firmware management is developer/admin-only. Admins are an explicit allowlist
// of Clerk user ids in the ADMIN_USER_IDS env var (comma-separated). There is no
// admin role in the DB; this keeps the surface tiny and server-only.
import { auth } from "@clerk/nextjs/server";

export function adminUserIds(): string[] {
  return (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAdminUser(userId: string | null | undefined): boolean {
  return !!userId && adminUserIds().includes(userId);
}

// For server actions: returns the admin user id or null if the caller isn't one.
export function adminUserId(): string | null {
  const { userId } = auth();
  return isAdminUser(userId) ? userId : null;
}
