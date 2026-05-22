"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = (localStorage.getItem("humid-theme") as Theme | null) ?? "dark";
    setTheme(stored);
    setMounted(true);
  }, []);

  function flip() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("humid-theme", next);
    } catch {}
  }

  // Render a stable label after hydration to avoid flicker.
  const label = mounted ? (theme === "dark" ? "Light" : "Dark") : "Theme";

  return (
    <button type="button" onClick={flip} aria-label="Toggle theme">
      {label}
    </button>
  );
}
