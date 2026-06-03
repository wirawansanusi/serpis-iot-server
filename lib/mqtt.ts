// MQTT bridge between the backend and the IR blaster fleet.
//
// - publishCommand() pushes a command to serpis/ir/<pubid>/cmd (QoS1).
// - A subscriber on serpis/ir/+/evt records command acks into device_commands;
//   a subscriber on serpis/ir/+/status (retained LWT) keeps the device fresh.
//
// The client is a process-wide singleton stashed on globalThis so Next.js dev
// HMR and multiple route imports reuse one connection. Inside the Docker network
// the backend talks to the broker over plaintext (MQTT_URL=mqtt://serpis-mqtt:1883);
// devices use TLS on 8883.

import mqtt, { type MqttClient } from "mqtt";
import { supabase } from "@/lib/supabase";

const PREFIX = "serpis/ir";

type Globals = { __serpisMqtt?: MqttClient | null };
const g = globalThis as unknown as Globals;

function getClient(): MqttClient | null {
  if (g.__serpisMqtt !== undefined && g.__serpisMqtt !== null) return g.__serpisMqtt;

  const url = process.env.MQTT_URL;
  if (!url) {
    console.warn("[mqtt] MQTT_URL not set; command publish disabled");
    g.__serpisMqtt = null;
    return null;
  }

  const client = mqtt.connect(url, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    reconnectPeriod: 3000,
    clientId: `humid-server-${Math.random().toString(16).slice(2, 8)}`,
  });

  client.on("connect", () => {
    console.log("[mqtt] connected");
    client.subscribe([`${PREFIX}/+/evt`, `${PREFIX}/+/status`], { qos: 1 }, (err) => {
      if (err) console.error("[mqtt] subscribe failed", err.message);
    });
  });
  client.on("error", (err) => console.error("[mqtt] error", err.message));
  client.on("message", (topic, payload) => {
    void onMessage(topic, payload).catch((e) => console.error("[mqtt] onMessage", e));
  });

  g.__serpisMqtt = client;
  return client;
}

// topic = serpis/ir/<pubid>/<evt|status>
async function onMessage(topic: string, payload: Buffer): Promise<void> {
  const parts = topic.split("/");
  if (parts.length !== 4) return;
  const publicDeviceId = parts[2];
  const leaf = parts[3];

  if (leaf === "status") {
    // Retained LWT: "online" | "offline". Touch last_seen so the dashboard's
    // freshness-based online flag flips up immediately on (re)connect.
    if (payload.toString() === "online") {
      await supabase.from("devices").update({ last_seen: new Date().toISOString() })
        .eq("public_device_id", publicDeviceId);
    }
    return;
  }

  if (leaf === "evt") {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload.toString());
    } catch {
      console.error("[mqtt] bad evt json from", publicDeviceId);
      return;
    }
    // Command ack: {id, kind:"ack", ok, error?}
    if (evt.kind === "ack" && typeof evt.id === "string") {
      await supabase.from("device_commands").update({
        status: evt.ok ? "acked" : "failed",
        acked_at: new Date().toISOString(),
        ack_ok: !!evt.ok,
        ack_error: typeof evt.error === "string" ? evt.error.slice(0, 200) : null,
      }).eq("id", evt.id);
    }
    // Learned codes ({kind:"learned", ...}) are handled in the DIY-learn phase.
  }
}

// Force the singleton + subscriber to come up (used at route load so acks are
// captured even before the first publish).
export function ensureMqtt(): void {
  getClient();
}

// Publish a command to a device. Returns false if the broker is unreachable.
export async function publishCommand(publicDeviceId: string, command: unknown): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  const topic = `${PREFIX}/${publicDeviceId}/cmd`;
  return new Promise<boolean>((resolve) => {
    client.publish(topic, JSON.stringify(command), { qos: 1 }, (err) => {
      if (err) {
        console.error("[mqtt] publish failed", err.message);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}
