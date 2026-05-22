#!/usr/bin/env node
/**
 * Stress test for /.netlify/functions/supabase-db-set-submission.
 *
 * Simulates N concurrent students hitting "save" at the same instant —
 * the path that bumps `updated_at` and may collide on the same row when
 * a class submits in unison. To avoid mutating real student bodies the
 * script does a no-op save: it first pulls each student's current
 * submission via supabase-share-bootstrap, then pushes that *same*
 * submission back. Server-side teacher-only field protection takes care
 * of approvedAt/rejectReason regardless.
 *
 * Usage:
 *   node scripts/stress-save.mjs \
 *     --base https://writing-program.netlify.app \
 *     --token <shareToken> \
 *     --creds students.csv \
 *     [--concurrency 30] [--rounds 1]
 */
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

function loadCreds(path) {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  return raw.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [studentNo, studentCode] = l.split(",").map((s) => s.trim());
      if (!studentNo || !studentCode) return null;
      // Skip header: studentNo for this project is always digits.
      if (!/^\d+$/.test(studentNo)) return null;
      return { studentNo, studentCode };
    })
    .filter(Boolean);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function postJson(url, body) {
  const start = performance.now();
  let status = 0, bodyText = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    bodyText = await res.text();
  } catch (e) {
    return { status: 0, elapsed: performance.now() - start, body: `network: ${e.message}` };
  }
  return { status, elapsed: performance.now() - start, body: bodyText };
}

async function main() {
  const args = parseArgs(process.argv);
  const base = String(args.base ?? "").replace(/\/$/, "");
  const token = args.token;
  const concurrency = Number(args.concurrency ?? 30);
  const rounds = Number(args.rounds ?? 1);
  if (!base || !token || !args.creds) {
    console.error("Usage: node scripts/stress-save.mjs --base <url> --token <shareToken> --creds students.csv [--concurrency 30] [--rounds 1]");
    process.exit(2);
  }
  const bootstrapUrl = `${base}/.netlify/functions/supabase-share-bootstrap`;
  const saveUrl = `${base}/.netlify/functions/supabase-db-set-submission`;
  const allCreds = loadCreds(args.creds);
  console.log(`Loaded ${allCreds.length} students. Concurrency=${concurrency}, Rounds=${rounds}`);

  // ── Phase A: serially pre-bootstrap each student so the save phase
  // only measures the write path (no fan-out into 11 read queries).
  console.log("\nPre-fetching each student's current submission via share-bootstrap...");
  const students = [];
  for (const c of allCreds.slice(0, concurrency)) {
    const r = await postJson(bootstrapUrl, {
      shareToken: token,
      studentNo: c.studentNo,
      studentCode: c.studentCode,
    });
    if (r.status !== 200) {
      console.warn(`  ${c.studentNo}: bootstrap ${r.status} — skipping. body=${r.body.slice(0, 200)}`);
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(r.body); } catch { continue; }
    const db = parsed.db;
    if (!db || !Array.isArray(db.submissions)) continue;
    const share = (db.shares || []).find((s) => s.token === token);
    const assignmentId = share?.assignmentId;
    const mine = db.submissions.find(
      (s) => s.studentNo === c.studentNo && s.assignmentId === assignmentId,
    );
    if (!mine) {
      console.warn(`  ${c.studentNo}: no submission row in bootstrap response. skipping.`);
      continue;
    }
    students.push({ creds: c, submission: mine });
  }
  console.log(`  → ${students.length} students ready for save test`);
  if (students.length === 0) { process.exit(1); }

  // Pad to `concurrency` by cycling through ready students. Each save
  // still targets a distinct (assignment_id, class_id, student_no) row
  // when student count >= concurrency, which is the production worst
  // case (every student saves at once). If fewer students were ready
  // than concurrency, some rows will receive multiple writes — that's
  // also a useful stress (row-level lock contention).
  const fireList = Array.from({ length: concurrency }, (_, i) => students[i % students.length]);

  const allResults = [];
  for (let r = 0; r < rounds; r++) {
    console.log(`\nRound ${r + 1}/${rounds}: firing ${concurrency} concurrent saves...`);
    const tasks = fireList.map((s) =>
      postJson(saveUrl, {
        shareToken: token,
        studentNo: s.creds.studentNo,
        studentCode: s.creds.studentCode,
        // Send the submission back verbatim. updatedAt is also unchanged,
        // and server-side teacher-only field protection guards approval
        // timestamps regardless.
        submission: s.submission,
      }),
    );
    const results = await Promise.all(tasks);
    allResults.push(...results);
  }

  const byStatus = new Map();
  const latencies = [];
  const firstErrors = [];
  for (const r of allResults) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    latencies.push(r.elapsed);
    if (r.status !== 200 && firstErrors.length < 5) {
      firstErrors.push({ status: r.status, body: r.body.slice(0, 300) });
    }
  }
  latencies.sort((a, b) => a - b);

  console.log(`\n=== Save Results ===`);
  console.log(`  Status:`);
  for (const [status, count] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    const tag = status === 0 ? "network-fail" : String(status);
    console.log(`    ${tag.padStart(12)}: ${count}`);
  }
  console.log(`  Latency (ms):`);
  console.log(
    `    min ${Math.round(latencies[0] ?? 0)} | p50 ${Math.round(percentile(latencies, 50))} | p95 ${Math.round(percentile(latencies, 95))} | max ${Math.round(latencies[latencies.length - 1] ?? 0)}`,
  );
  if (firstErrors.length > 0) {
    console.log(`  First error bodies (up to 5):`);
    for (const e of firstErrors) {
      console.log(`    [${e.status}] ${e.body}`);
    }
  }
  const bad = allResults.filter((r) => r.status === 0 || r.status >= 500).length;
  console.log(`\nSummary: ${allResults.length - bad}/${allResults.length} OK, ${bad} 5xx/network-fail.`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
