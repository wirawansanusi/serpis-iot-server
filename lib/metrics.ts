// Metric chart-type vocabulary. A "metric" is a self-describing measurement a
// device reports (temp_c, humidity, co2, ...); its display/viz config lives in
// the `metrics` registry table. The ingest route validates an incoming metric's
// chart_type against this. (The web backend no longer renders charts — that UI
// moved to the Serpis IoT mobile app — so the old color/format/type helpers were
// removed; the dashboard API defines its own row shapes inline.)

export type ChartType = "line" | "area" | "gauge" | "bar" | "state";
