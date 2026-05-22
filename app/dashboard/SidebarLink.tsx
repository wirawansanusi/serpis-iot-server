"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SidebarLink({
  id,
  name,
  online,
  pct,
  sparkPath,
}: {
  id: string;
  name: string;
  online: boolean;
  pct: number | null;
  sparkPath: string;
}) {
  const pathname = usePathname();
  const active = pathname?.startsWith(`/dashboard/${id}`);
  const pctClass = pct !== null && pct < 90 ? "pct bad" : "pct";

  return (
    <Link href={`/dashboard/${id}`} className={active ? "active" : undefined}>
      <svg className="spark" width="80" height="24" viewBox="0 0 80 24" aria-hidden>
        {sparkPath ? (
          <path d={sparkPath} fill="none" stroke={online ? "var(--good)" : "var(--muted)"} strokeWidth="1.5" />
        ) : (
          <line x1="0" y1="12" x2="80" y2="12" stroke="var(--border)" strokeDasharray="2 3" />
        )}
      </svg>
      <div className="row-main">
        <div className="row-name">{name}</div>
        <div className="row-meta">{online ? "online" : "offline"}</div>
      </div>
      {pct !== null && <span className={pctClass}>{pct}%</span>}
    </Link>
  );
}
