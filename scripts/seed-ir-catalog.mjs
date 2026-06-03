#!/usr/bin/env node
// Seed the IR catalog (ir_brands / ir_models / ir_functions).
//
//   node --env-file=.env.local scripts/seed-ir-catalog.mjs
//       [--flipper /path/to/Flipper-IRDB] [--irdb /path/to/irdb] [--limit N]
//
// Always seeds a CURATED set (AC vendor mappings + a few verified TV remotes)
// so the catalog is usable immediately with no downloads. The optional importers
// add broad coverage from the open databases:
//   --flipper : Flipper-IRDB .ir files (raw + parsed NEC/Samsung)
//   --irdb    : probonopd/irdb CSVs (NEC family)
//
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Idempotent (re-running
// updates models in place and replaces their buttons).

import { readdirSync, readFileSync, statSync } from "fs";
import { join, basename, sep } from "path";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  console.error("Tip: node --env-file=.env.local scripts/seed-ir-catalog.mjs");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flipperDir = arg("--flipper", null);
const irdbDir = arg("--irdb", null);
const limit = parseInt(arg("--limit", "0"), 10) || 0;

// ---- bit helpers (mirror IRremoteESP8266 encoders) ------------------------

function reverseBits(value, nbits) {
  let result = 0n;
  let v = BigInt(value) & ((1n << BigInt(nbits)) - 1n);
  for (let i = 0; i < nbits; i++) {
    result = (result << 1n) | (v & 1n);
    v >>= 1n;
  }
  return result;
}
// IRsend::encodeNEC
function encodeNEC(address, command) {
  command &= 0xff;
  command |= (command ^ 0xff) << 8;
  let v;
  if (address > 0xff) v = (((command << 16) >>> 0) + (address & 0xffff)) >>> 0;
  else v = (((command << 16) >>> 0) + ((address << 8) >>> 0) + (address ^ 0xff)) >>> 0;
  return Number(reverseBits(v, 32) & 0xffffffffn);
}
// IRsend::encodeSamsung
function encodeSamsung(customer, command) {
  const c = Number(reverseBits(customer & 0xff, 8));
  const m = Number(reverseBits(command & 0xff, 8));
  return (((m << 24) >>> 0) | (m << 16) | (c << 8) | c) >>> 0;
}
const hex = (n) => "0x" + (n >>> 0).toString(16).toUpperCase();

// ---- DB helpers -----------------------------------------------------------

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const brandCache = new Map();

async function findOrCreateBrand(name) {
  const slug = slugify(name);
  if (brandCache.has(slug)) return brandCache.get(slug);
  const { data: existing } = await supabase.from("ir_brands").select("id").eq("slug", slug).maybeSingle();
  let id = existing?.id;
  if (!id) {
    const { data, error } = await supabase.from("ir_brands").insert({ name, slug }).select("id").single();
    if (error) throw error;
    id = data.id;
  }
  brandCache.set(slug, id);
  return id;
}

async function upsertModel({ brandId, name, kind, acVendor = null, source, sourceRef = null }) {
  const { data: existing } = await supabase
    .from("ir_models")
    .select("id")
    .eq("brand_id", brandId)
    .eq("name", name)
    .eq("device_kind", kind)
    .maybeSingle();
  if (existing?.id) {
    await supabase.from("ir_models").update({ ac_vendor: acVendor, source, source_ref: sourceRef }).eq("id", existing.id);
    return existing.id;
  }
  const { data, error } = await supabase
    .from("ir_models")
    .insert({ brand_id: brandId, name, device_kind: kind, ac_vendor: acVendor, source, source_ref: sourceRef })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function replaceFunctions(modelId, fns) {
  await supabase.from("ir_functions").delete().eq("model_id", modelId);
  if (fns.length === 0) return;
  const rows = fns.map((f, i) => ({
    model_id: modelId,
    name: f.name,
    command: f.command,
    sort_order: f.sort_order ?? i * 10,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from("ir_functions").insert(rows.slice(i, i + 200));
    if (error) throw error;
  }
}

// ---- curated data ---------------------------------------------------------

// AC brand -> IRremoteESP8266 protocol name (must match strToDecodeType on the
// firmware). These drive the parametric climate panel (kind=ac).
const AC_VENDORS = [
  ["Daikin", "DAIKIN"], ["Mitsubishi", "MITSUBISHI_AC"], ["Mitsubishi Heavy", "MITSUBISHI_HEAVY_152"],
  ["Gree", "GREE"], ["Fujitsu", "FUJITSU_AC"], ["Panasonic", "PANASONIC_AC"], ["Samsung", "SAMSUNG_AC"],
  ["LG", "LG"], ["Toshiba", "TOSHIBA_AC"], ["Hitachi", "HITACHI_AC"], ["Sharp", "SHARP_AC"],
  ["Carrier", "CARRIER_AC"], ["Midea", "MIDEA"], ["Haier", "HAIER_AC"], ["Electra", "ELECTRA_AC"],
  ["Whirlpool", "WHIRLPOOL_AC"], ["Kelvinator", "KELVINATOR"], ["TCL", "TCL112AC"], ["Teco", "TECO"],
  ["Vestel", "VESTEL_AC"], ["Sanyo", "SANYO_AC"], ["Argo", "ARGO"], ["Trotec", "TROTEC"],
  ["Coolix (generic)", "COOLIX"],
];

const TV_ORDER = ["Power","Input","Vol+","Vol-","Mute","Ch+","Ch-","Menu","Home","Up","Down","Left","Right","OK","Back","Exit"];
function tvButtons(protocol, bits, codes, repeats = 0) {
  return Object.entries(codes).map(([name, code]) => {
    const command = { kind: "protocol", protocol, code, bits };
    if (repeats) command.repeats = repeats;
    const idx = TV_ORDER.indexOf(name);
    return { name, command, sort_order: idx >= 0 ? idx * 10 : 100 };
  });
}

const CURATED_TVS = [
  { brand: "Samsung", name: "Samsung TV", protocol: "SAMSUNG", bits: 32, codes: {
    Power: "0xE0E040BF", Input: "0xE0E0807F", "Vol+": "0xE0E0E01F", "Vol-": "0xE0E0D02F",
    Mute: "0xE0E0F00F", "Ch+": "0xE0E048B7", "Ch-": "0xE0E008F7", Menu: "0xE0E058A7",
    Up: "0xE0E006F9", Down: "0xE0E08679", Left: "0xE0E0A659", Right: "0xE0E046B9", OK: "0xE0E016E9" } },
  { brand: "LG", name: "LG TV", protocol: "NEC", bits: 32, codes: {
    Power: "0x20DF10EF", Input: "0x20DFD02F", "Vol+": "0x20DF40BF", "Vol-": "0x20DFC03F",
    Mute: "0x20DF906F", "Ch+": "0x20DF00FF", "Ch-": "0x20DF807F", Menu: "0x20DFC23D",
    Up: "0x20DF02FD", Down: "0x20DF827D", Left: "0x20DFE01F", Right: "0x20DF609F", OK: "0x20DF22DD" } },
  { brand: "Sony", name: "Sony TV", protocol: "SONY", bits: 12, repeats: 2, codes: {
    Power: "0xA90", Input: "0xA50", "Vol+": "0x490", "Vol-": "0xC90",
    Mute: "0x290", "Ch+": "0x090", "Ch-": "0x890" } },
];

async function seedCurated() {
  let brands = 0, models = 0;
  for (const [brand, vendor] of AC_VENDORS) {
    const brandId = await findOrCreateBrand(brand);
    await upsertModel({ brandId, name: `${brand} AC`, kind: "ac", acVendor: vendor, source: "curated" });
    models++; brands++;
  }
  for (const tv of CURATED_TVS) {
    const brandId = await findOrCreateBrand(tv.brand);
    const modelId = await upsertModel({ brandId, name: tv.name, kind: "tv", source: "curated" });
    await replaceFunctions(modelId, tvButtons(tv.protocol, tv.bits, tv.codes, tv.repeats));
    models++;
  }
  console.log(`[curated] ${AC_VENDORS.length} AC vendors + ${CURATED_TVS.length} TVs (${models} models)`);
}

// ---- Flipper-IRDB importer ------------------------------------------------

function flipperKind(category) {
  const c = category.toLowerCase();
  if (c.includes("tv")) return "tv";
  if (c.includes("audio") || c.includes("receiver") || c.includes("speaker")) return "audio";
  if (c.includes("projector")) return "projector";
  if (c.includes("box") || c.includes("streaming") || c.includes("stb")) return "stb";
  if (c.includes("fan")) return "fan";
  if (c.includes("led") || c.includes("light")) return "light";
  if (c.includes("conditioner") || c === "acs") return "ac"; // skipped (panel-driven)
  return "other";
}

function parseFlipperFile(text) {
  const out = [];
  for (const block of text.split(/^#.*$/m)) {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (m) fields[m[1].toLowerCase()] = m[2].trim();
    }
    if (!fields.name || !fields.type) continue;
    const name = fields.name.replace(/_/g, " ");
    if (fields.type === "raw" && fields.data && fields.frequency) {
      const timings = fields.data.split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
      const carrier = parseInt(fields.frequency, 10);
      if (timings.length < 2 || timings.length > 1024) continue;
      if (timings.some((t) => t <= 0 || t > 70000)) continue;
      if (!(carrier >= 30000 && carrier <= 60000)) continue;
      out.push({ name, command: { kind: "raw", carrier_hz: carrier, timings_us: timings } });
    } else if (fields.type === "parsed" && fields.protocol) {
      const proto = fields.protocol.toUpperCase();
      const ab = (fields.address || "").split(/\s+/).map((h) => parseInt(h, 16));
      const cb = (fields.command || "").split(/\s+/).map((h) => parseInt(h, 16));
      if (!ab.length || !cb.length || Number.isNaN(ab[0]) || Number.isNaN(cb[0])) continue;
      if (proto === "NEC") {
        out.push({ name, command: { kind: "protocol", protocol: "NEC", code: hex(encodeNEC(ab[0], cb[0])), bits: 32 } });
      } else if (proto === "NECEXT") {
        const addr16 = (ab[0] | ((ab[1] || 0) << 8)) >>> 0;
        out.push({ name, command: { kind: "protocol", protocol: "NEC", code: hex(encodeNEC(addr16, cb[0])), bits: 32 } });
      } else if (proto === "SAMSUNG32") {
        out.push({ name, command: { kind: "protocol", protocol: "SAMSUNG", code: hex(encodeSamsung(ab[0], cb[0])), bits: 32 } });
      }
      // other parsed protocols (Sony/RC5/RC6/...) are skipped — most Flipper
      // files include an equivalent raw entry that is imported above.
    }
  }
  return out;
}

function walk(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (entry.toLowerCase().endsWith(".ir")) files.push(p);
    }
  }
  return files;
}

async function seedFlipper(root) {
  const files = walk(root);
  console.log(`[flipper] ${files.length} .ir files under ${root}`);
  let done = 0, imported = 0, skipped = 0;
  for (const file of files) {
    if (limit && imported >= limit) break;
    const rel = file.slice(root.length).split(sep).filter(Boolean);
    const category = rel[0] || "other";
    const brandName = rel.length >= 2 ? rel[rel.length - 2] : "Unknown";
    const kind = flipperKind(category);
    if (kind === "ac") { skipped++; continue; } // AC uses curated vendor panel
    const modelName = basename(file, ".ir").replace(/_/g, " ");
    let fns;
    try { fns = parseFlipperFile(readFileSync(file, "utf8")); } catch { skipped++; continue; }
    if (fns.length === 0) { skipped++; continue; }
    try {
      const brandId = await findOrCreateBrand(brandName.replace(/_/g, " "));
      const modelId = await upsertModel({ brandId, name: modelName, kind, source: "flipper", sourceRef: rel.join("/") });
      await replaceFunctions(modelId, fns);
      imported++;
    } catch (e) { console.error("  ! ", rel.join("/"), e.message); skipped++; }
    if (++done % 200 === 0) console.log(`  ...${done}/${files.length} (imported ${imported}, skipped ${skipped})`);
  }
  console.log(`[flipper] imported ${imported} models, skipped ${skipped}`);
}

// ---- IRDB importer (NEC family) ------------------------------------------

function irdbKind(deviceType) {
  const c = deviceType.toLowerCase();
  if (c.includes("tv") || c.includes("television")) return "tv";
  if (c.includes("audio") || c.includes("receiver") || c.includes("amp") || c.includes("cd")) return "audio";
  if (c.includes("projector")) return "projector";
  if (c.includes("box") || c.includes("streaming") || c.includes("sat")) return "stb";
  return "other";
}

function parseIrdbCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const fns = [];
  for (const line of lines.slice(1)) {
    const [fn, protocol, device, subdevice, func] = line.split(",");
    if (!protocol) continue;
    const p = protocol.toUpperCase();
    const dev = parseInt(device, 10), sub = parseInt(subdevice, 10), command = parseInt(func, 10);
    if (Number.isNaN(dev) || Number.isNaN(command)) continue;
    if (p === "NEC1" || p === "NEC") {
      fns.push({ name: fn.replace(/^KEY_/, ""), command: { kind: "protocol", protocol: "NEC", code: hex(encodeNEC(dev, command)), bits: 32 } });
    } else if (p === "NECX1" || p === "NECX2" || p === "NECX") {
      const addr16 = sub >= 0 ? ((dev | (sub << 8)) >>> 0) : dev;
      fns.push({ name: fn.replace(/^KEY_/, ""), command: { kind: "protocol", protocol: "NEC", code: hex(encodeNEC(addr16, command)), bits: 32 } });
    }
    // non-NEC protocols are skipped (reconstruction is protocol-specific).
  }
  return fns;
}

async function seedIrdb(root) {
  const codesDir = statSync(join(root, "codes"), { throwIfNoEntry: false })?.isDirectory() ? join(root, "codes") : root;
  const brands = readdirSync(codesDir).filter((b) => statSync(join(codesDir, b)).isDirectory());
  console.log(`[irdb] ${brands.length} brands under ${codesDir}`);
  let imported = 0, skipped = 0;
  for (const brand of brands) {
    if (limit && imported >= limit) break;
    const brandPath = join(codesDir, brand);
    for (const deviceType of readdirSync(brandPath)) {
      const dtPath = join(brandPath, deviceType);
      if (!statSync(dtPath).isDirectory()) continue;
      const kind = irdbKind(deviceType);
      for (const csv of readdirSync(dtPath)) {
        if (!csv.endsWith(".csv")) continue;
        let fns;
        try { fns = parseIrdbCsv(readFileSync(join(dtPath, csv), "utf8")); } catch { skipped++; continue; }
        if (fns.length === 0) { skipped++; continue; }
        try {
          const brandId = await findOrCreateBrand(brand);
          const modelName = `${deviceType} ${basename(csv, ".csv")}`.trim();
          const modelId = await upsertModel({ brandId, name: modelName, kind, source: "irdb", sourceRef: `${brand}/${deviceType}/${csv}` });
          await replaceFunctions(modelId, fns);
          imported++;
        } catch (e) { console.error("  ! ", brand, deviceType, csv, e.message); skipped++; }
      }
    }
    if (imported % 100 === 0 && imported) console.log(`  ...imported ${imported}`);
  }
  console.log(`[irdb] imported ${imported} models, skipped ${skipped}`);
}

// ---- run ------------------------------------------------------------------

await seedCurated();
if (flipperDir) await seedFlipper(flipperDir);
if (irdbDir) await seedIrdb(irdbDir);
console.log("Done.");
