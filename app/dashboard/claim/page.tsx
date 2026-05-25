import Link from "next/link";

// Devices are now claimed from the Humid mobile app over Bluetooth (proof of
// physical possession), not by typing a MAC address. This page guides the user
// there; the "+ Add device" sidebar link still points here.
export default function ClaimPage() {
  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: 22, marginTop: 0 }}>Add a device</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Humid devices are now added from the <strong>Humid mobile app</strong>, which pairs
        with the device over Bluetooth to confirm it&apos;s really yours.
      </p>
      <ol style={{ color: "var(--text)", lineHeight: 1.7, paddingLeft: 18 }}>
        <li>Power on the device and finish Wi-Fi setup in its captive portal.</li>
        <li>Open the Humid app and sign in with this same account.</li>
        <li>Tap <strong>Add device</strong> — the app finds it over Bluetooth and claims it.</li>
      </ol>
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        If the device isn&apos;t found, short-press its pair button to reopen the
        pairing window, then scan again.
      </p>
      <p className="foot">
        <Link href="/dashboard">Back to dashboard</Link>
      </p>
    </div>
  );
}
