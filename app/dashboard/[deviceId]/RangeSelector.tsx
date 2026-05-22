"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];

export function RangeSelector({ active }: { active: Range }) {
  const pathname = usePathname() ?? "";
  const search = useSearchParams();

  function hrefFor(r: Range): string {
    const params = new URLSearchParams(search?.toString() ?? "");
    params.set("range", r);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <nav className="range" aria-label="Time range">
      {RANGES.map((r) => (
        <Link key={r} href={hrefFor(r)} className={r === active ? "active" : undefined}>
          {r}
        </Link>
      ))}
    </nav>
  );
}
