"use client";

import { useEffect, useState } from "react";

type ThemeMode = "tech" | "hn";

function applyTheme(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode;
}

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("tech");

  useEffect(() => {
    const saved = window.localStorage.getItem("aionis-theme") as ThemeMode | null;
    const nextMode = saved === "hn" ? "hn" : "tech";
    setMode(nextMode);
    applyTheme(nextMode);
  }, []);

  function update(nextMode: ThemeMode) {
    setMode(nextMode);
    applyTheme(nextMode);
    window.localStorage.setItem("aionis-theme", nextMode);
  }

  return (
    <div className="themeToggle" aria-label="Theme mode switch">
      <button type="button" className={mode === "tech" ? "active" : ""} onClick={() => update("tech")}>
        Tech
      </button>
      <button type="button" className={mode === "hn" ? "active" : ""} onClick={() => update("hn")}>
        HN Minimal
      </button>
    </div>
  );
}
