"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Re-fetches the current server component tree on an interval.
// Unlike <meta http-equiv="refresh">, this preserves client state — open
// rename inputs, chart hover, scroll position, etc.
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
