// Refreshes water-stats.json using the same sources and rules as the live
// Water Signal Tracker app (src/lib/wst-data.ts): legacy Google Sheet rows
// + native app reports from the public, non-identifying view. Read-only.
import { readFileSync, writeFileSync } from "node:fs";

const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/1P2mZbeC0L1iCZczMATXNkUgSHl6aO_mCrbOAOhdD0TQ/export?format=csv";
const SUPABASE_URL = "https://ohufkvrmectdloupndmu.supabase.co";
// Publishable (public) key — the same one the app ships to every browser.
const SUPABASE_KEY = "sb_publishable_eyoVwvurW6A54EMbmNkdJQ_r8XhWOQU";

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

const pick = (row, keys) => keys.map((k) => row[k]).find((v) => v) || "";

export function sheetToReports(rows) {
  return rows.map((row) => ({
    parish: pick(row, ["Parish"]),
    status: pick(row, ["Water Status Right Now", "Water Status Right N", "Water Status Right Now?"]),
    days: pick(row, ["How many days without water?", "How many days witho"]),
  }));
}

const parishKey = (p) => (p || "").toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ").trim();

export function computeStats(reports) {
  return {
    totalReports: reports.length,
    noWaterReports: reports.filter((r) => (r.status || "").toLowerCase().includes("no water")).length,
    parishesImpacted: new Set(reports.map((r) => parishKey(r.parish)).filter(Boolean)).size,
    longOutReports: reports.filter((r) => /7|month/i.test(r.days || "")).length,
  };
}

async function main() {
  const sheetRes = await fetch(SHEET_CSV);
  if (!sheetRes.ok) throw new Error(`Sheet HTTP ${sheetRes.status}`);
  const sheet = sheetToReports(parseCsv(await sheetRes.text()));

  const appRes = await fetch(
    `${SUPABASE_URL}/rest/v1/app_reports_public?select=parish,water_status,days_without&limit=1000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  if (!appRes.ok) throw new Error(`App HTTP ${appRes.status}: ${await appRes.text()}`);
  const app = (await appRes.json()).map((r) => ({
    parish: r.parish, status: r.water_status, days: r.days_without,
  }));

  const stats = computeStats([...sheet, ...app]);
  if (stats.totalReports === 0) throw new Error("Zero reports — refusing to overwrite");

  const prev = JSON.parse(readFileSync("water-stats.json", "utf8"));
  const changed = ["totalReports", "noWaterReports", "parishesImpacted", "longOutReports"]
    .some((k) => prev[k] !== stats[k]);
  console.log(`sheet=${sheet.length} app=${app.length}`, stats, changed ? "CHANGED" : "unchanged");
  if (!changed) return;

  const lastUpdated = new Date().toLocaleString("en-US", { timeZone: "America/Grenada" });
  writeFileSync("water-stats.json",
    JSON.stringify({ ...stats, lastUpdated }, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
