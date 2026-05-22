import Link from "next/link";
import { claimDevice } from "./actions";

export default function ClaimPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: 22, marginTop: 0 }}>Claim a device</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Enter the MAC address of your Humid device. You can find it in the
        device&apos;s captive-portal page, or in the server logs after the
        device sends its first reading.
      </p>
      <form action={claimDevice} className="stack">
        <label htmlFor="mac">MAC address</label>
        <input
          id="mac"
          name="mac"
          required
          placeholder="AA:BB:CC:DD:EE:FF"
          autoComplete="off"
          spellCheck={false}
          style={{ fontFamily: "ui-monospace, monospace" }}
        />
        <button type="submit">Claim</button>
      </form>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      <p className="foot">
        <Link href="/dashboard">Back to dashboard</Link>
      </p>
    </div>
  );
}
