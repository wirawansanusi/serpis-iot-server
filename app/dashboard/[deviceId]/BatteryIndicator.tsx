// iOS-style battery status: a battery glyph filled to the level, colored by
// charge (green / amber / red), with a charging bolt + "Plugged in" when the
// device reports external power. Battery is device status, not a charted metric.
export function BatteryIndicator({
  percent,
  powerSource,
  mv,
}: {
  percent: number | null;
  powerSource: string | null;
  mv: number | null;
}) {
  const charging = powerSource === "external";
  const hasPct = typeof percent === "number";
  const lvl = hasPct ? Math.max(0, Math.min(100, percent as number)) : 100;
  const color = charging
    ? "var(--good)"
    : lvl <= 10
      ? "var(--bad)"
      : lvl <= 20
        ? "var(--warn)"
        : "var(--good)";
  const fillW = ((charging && !hasPct ? 100 : lvl) / 100) * 38;

  const big = charging ? (hasPct ? `${Math.round(lvl)}%` : "Charging") : hasPct ? `${Math.round(lvl)}%` : "—";
  const caption = charging
    ? "Plugged in"
    : hasPct
      ? "On battery"
      : mv
        ? `${(mv / 1000).toFixed(2)} V`
        : "no data";

  return (
    <div className="stat">
      <div className="label">Battery</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
        <svg width="52" height="24" viewBox="0 0 52 24" aria-hidden>
          <rect x="1" y="3" width="44" height="18" rx="4" fill="none" stroke="var(--border-strong)" strokeWidth="2" />
          <rect x="46.5" y="8" width="3.5" height="8" rx="1.75" fill="var(--border-strong)" />
          <rect x="4" y="6" width={fillW} height="12" rx="2" fill={color} />
          {charging && <path d="M25 5 L19 13 L23.5 13 L21 19 L30 10.5 L25 10.5 Z" fill="var(--card)" />}
        </svg>
        <span className="value" style={{ fontSize: 22 }}>{big}</span>
      </div>
      <div className="sub">{caption}</div>
    </div>
  );
}
