import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Humid",
  description: "Humidity sensor dashboard",
};

// Set the theme before first paint to avoid a flash.
const themeBootScript = `
  try {
    var t = localStorage.getItem('humid-theme') || 'dark';
    document.documentElement.dataset.theme = t;
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
`;

const styles = `
  :root {
    --bg: #f4f6f8;
    --card: #ffffff;
    --text: #1a1a1a;
    --muted: #5a6470;
    --border: #d8dde3;
    --border-strong: #c0c7cf;
    --accent: #0066ff;
    --accent-fg: #ffffff;
    --good: #0a8a3f;
    --good-bg: #e6f7ec;
    --bad: #b1322a;
    --bad-bg: #fdecec;
    --warn: #7a4d00;
    --warn-bg: #fff7e0;
    --warn-border: #f0c46a;
    --hover: #f4f6f8;
    --chart-grid: #e6e9ec;
  }
  [data-theme="dark"] {
    --bg: #0f1419;
    --card: #1a2027;
    --text: #e6e9ec;
    --muted: #8a949e;
    --border: #2a323a;
    --border-strong: #3a434c;
    --accent: #4d9fff;
    --accent-fg: #0f1419;
    --good: #3ec07a;
    --good-bg: #14301f;
    --bad: #ef6b63;
    --bad-bg: #321713;
    --warn: #f0c46a;
    --warn-bg: #2a2110;
    --warn-border: #5a4a20;
    --hover: #232a32;
    --chart-grid: #232a32;
  }

  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
  }

  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Centered layouts (login, signup, claim) */
  main.centered {
    max-width: 380px;
    margin: 80px auto 0;
    padding: 24px;
    background: var(--card);
    border-radius: 12px;
    border: 1px solid var(--border);
  }
  main.centered h1 { font-size: 22px; margin: 0 0 8px; }
  main.centered p.sub { color: var(--muted); margin: 0 0 20px; font-size: 14px; }

  form.stack { display: flex; flex-direction: column; gap: 12px; }
  form.stack label { font-size: 13px; font-weight: 600; color: var(--muted); }
  form.stack input {
    font: inherit; font-size: 15px;
    padding: 10px 12px;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    width: 100%;
  }
  form.stack input:focus { outline: none; border-color: var(--accent); }
  form.stack button[type="submit"] {
    font: inherit; font-size: 15px; font-weight: 600;
    padding: 11px 14px;
    background: var(--accent); color: var(--accent-fg);
    border: 1px solid var(--accent);
    border-radius: 8px;
    cursor: pointer;
    margin-top: 4px;
  }
  form.stack button[type="submit"]:hover { filter: brightness(1.05); }

  p.error { color: var(--bad); font-size: 13px; margin: 8px 0 0; }
  p.foot { font-size: 13px; color: var(--muted); margin-top: 16px; text-align: center; }

  /* Dashboard shell */
  .shell {
    display: grid;
    grid-template-columns: 280px 1fr;
    min-height: 100vh;
  }
  .topbar {
    grid-column: 1 / -1;
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 20px;
    background: var(--card);
    border-bottom: 1px solid var(--border);
  }
  .topbar .brand { font-weight: 700; font-size: 16px; }
  .topbar .right { display: flex; gap: 10px; align-items: center; }
  .topbar .right form { margin: 0; }
  .topbar button {
    font: inherit; font-size: 13px;
    padding: 6px 12px;
    background: transparent; color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
  }
  .topbar button:hover { background: var(--hover); }

  /* Sidebar */
  .sidebar {
    background: var(--card);
    border-right: 1px solid var(--border);
    padding: 16px;
    overflow-y: auto;
  }
  .sidebar h2 {
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--muted); margin: 0 0 12px;
  }
  .sidebar .add-btn {
    display: block; text-align: center;
    font-size: 13px; font-weight: 600;
    padding: 8px 12px; margin-bottom: 12px;
    background: var(--accent); color: var(--accent-fg);
    border-radius: 8px;
    text-decoration: none;
  }
  .sidebar .add-btn:hover { filter: brightness(1.05); text-decoration: none; }
  .sidebar nav { display: flex; flex-direction: column; gap: 4px; }
  .sidebar nav a {
    display: flex; align-items: center; gap: 10px;
    padding: 10px;
    border-radius: 8px;
    text-decoration: none; color: var(--text);
  }
  .sidebar nav a:hover { background: var(--hover); text-decoration: none; }
  .sidebar nav a.active { background: var(--hover); border: 1px solid var(--border); }
  .sidebar .row-main { flex: 1; min-width: 0; }
  .sidebar .row-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sidebar .row-meta { font-size: 11px; color: var(--muted); }
  .sidebar .pct {
    font-size: 11px; font-weight: 700;
    padding: 2px 6px; border-radius: 999px;
    background: var(--good-bg); color: var(--good);
  }
  .sidebar .pct.bad { background: var(--bad-bg); color: var(--bad); }
  .sidebar .spark { display: block; }
  .sidebar .empty { font-size: 13px; color: var(--muted); padding: 8px; }

  /* Detail panel */
  .detail { padding: 20px 28px; min-width: 0; }
  .detail h1 { font-size: 22px; margin: 0 0 8px; display: flex; align-items: center; gap: 10px; }
  .detail .mac { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; color: var(--muted); }
  .detail .pills { display: flex; gap: 8px; margin: 12px 0; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600;
  }
  .pill.good { background: var(--good-bg); color: var(--good); }
  .pill.bad  { background: var(--bad-bg); color: var(--bad); }
  .pill.muted { background: var(--hover); color: var(--muted); }
  .pill .dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; }

  .stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px; margin: 16px 0;
  }
  .stat {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px;
  }
  .stat .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
  .stat .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .stat .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }

  .actions { display: flex; gap: 8px; margin: 8px 0 16px; }
  .actions button, .actions a.btn {
    font: inherit; font-size: 13px;
    padding: 6px 12px;
    background: var(--card); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px;
    cursor: pointer; text-decoration: none;
  }
  .actions button:hover, .actions a.btn:hover { background: var(--hover); }
  .actions button.danger { color: var(--bad); border-color: var(--bad); }
  .actions button.danger:hover { background: var(--bad-bg); }
  form.rename { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
  form.rename input { flex: 1; font: inherit; font-size: 15px; padding: 6px 10px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; }
  form.rename button { font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; }
  form.rename button[type="submit"] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }

  /* Range selector */
  .range { display: inline-flex; gap: 4px; padding: 4px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; }
  .range a {
    font-size: 12px; font-weight: 600;
    padding: 4px 10px;
    border-radius: 5px;
    color: var(--muted);
    text-decoration: none;
  }
  .range a:hover { color: var(--text); background: var(--hover); text-decoration: none; }
  .range a.active { background: var(--accent); color: var(--accent-fg); }

  .chart-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px;
    margin-top: 12px;
  }

  /* Events table */
  h2.section { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 28px 0 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { padding: 10px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--border); }
  th { background: var(--bg); font-weight: 600; color: var(--muted); }
  tr:last-child td { border-bottom: none; }
  .kind { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); }

  /* Open-incidents banner */
  .banner { background: var(--warn-bg); border: 1px solid var(--warn-border); padding: 12px 16px; border-radius: 10px; margin-bottom: 16px; }
  .banner h2 { margin: 0 0 8px; color: var(--warn); font-size: 14px; }
  .banner ul { margin: 0; padding-left: 18px; color: var(--warn); font-size: 13px; }

  .empty { color: var(--muted); padding: 24px; text-align: center; background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <head>
          <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
          <style dangerouslySetInnerHTML={{ __html: styles }} />
        </head>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
