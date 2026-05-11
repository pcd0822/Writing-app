#!/usr/bin/env node
/**
 * Stress test for /.netlify/functions/supabase-share-bootstrap.
 *
 * Simulates N concurrent students hitting the share landing endpoint —
 * the path that used to 502/504 when 30 real students opened the link at
 * the same time. Reports status code distribution and latency stats so a
 * deploy can be validated quantitatively before exposing it to a class.
 *
 * Usage:
 *   node scripts/stress-share.mjs \
 *     --base https://writing-program.netlify.app \
 *     --token <shareToken> \
 *     [--concurrency 30] \
 *     [--rounds 1] \
 *     [--scenario landing|auth|both] \
 *     [--creds students.csv] \
 *     [--strict]
 *
 * CSV format (one student per line; lines starting with # are ignored):
 *   studentNo,studentCode
 *   30101,aB3dE9kQ
 *   30102,Xy7uV2nW
 *
 * The "auth" scenario is the heavier one — it fans out into the 6 child
 * tables (feedback_notes / ai_logs / scores / step_transitions /
 * ai_interactions / teacher_comments) per request, mirroring what
 * supabase-share-bootstrap does after the student lands and enters
 * credentials. Provide --creds with at least one valid (studentNo,
 * studentCode) pair to measure it. Fewer creds than --concurrency cycles
 * through them (acceptable for stress; Supabase pool cares about total
 * query count, not per-student identity).
 *
 * --strict makes the process exit with code 1 if any 5xx / network
 * failure was observed. Useful for CI-style regression checks. Default
 * exit code is 0 so casual measurement runs don't surprise the caller.
 *
 * Node 18+ required (built-in fetch). No external deps.
 */

import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function loadCreds(path) {
  if (!path) return [];
  // Excel-exported CSVs often have a UTF-8 BOM and a header row like
  // "학번,코드" or "studentNo,studentCode". Strip the BOM and skip any
  // row whose first field isn't a plain ASCII alphanumeric — the real
  // student numbers in this project are all digits, so a non-digit
  // first field reliably indicates a header.
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [studentNo, studentCode] = line.split(",").map((s) => s.trim());
      if (!studentNo || !studentCode) return null;
      if (!/^[A-Za-z0-9]+$/.test(studentNo)) return null; // skip header row
      return { studentNo, studentCode };
    })
    .filter(Boolean);
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.floor((p / 100) * sortedAsc.length),
  );
  return sortedAsc[idx];
}

async function fireOne(url, body) {
  const start = performance.now();
  let status = 0;
  let bodySize = 0;
  let errorBody = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    bodySize = text.length;
    if (status >= 400) errorBody = text.slice(0, 300);
  } catch (e) {
    status = 0;
    errorBody = `network error: ${e.message}`;
  }
  const elapsed = performance.now() - start;
  return { status, elapsed, bodySize, errorBody };
}

async function runScenario({ url, label, concurrency, rounds, makeBody }) {
  console.log(`\n=== Scenario: ${label} ===`);
  console.log(`  Concurrency: ${concurrency}, Rounds: ${rounds}`);
  const all = [];
  for (let r = 0; r < rounds; r++) {
    if (rounds > 1) console.log(`  Round ${r + 1}/${rounds} firing ${concurrency} concurrent...`);
    const tasks = Array.from({ length: concurrency }, (_, i) =>
      fireOne(url, makeBody(i)),
    );
    const results = await Promise.all(tasks);
    all.push(...results);
  }

  const byStatus = new Map();
  const latencies = [];
  const bodySizes = [];
  const firstErrors = [];
  for (const r of all) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    latencies.push(r.elapsed);
    bodySizes.push(r.bodySize);
    if (r.status !== 200 && firstErrors.length < 5) {
      firstErrors.push({ status: r.status, body: r.errorBody });
    }
  }
  latencies.sort((a, b) => a - b);
  bodySizes.sort((a, b) => a - b);

  console.log(`  Status:`);
  for (const [status, count] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    const tag = status === 0 ? "network-fail" : String(status);
    console.log(`    ${tag.padStart(12)}: ${count}`);
  }
  console.log(`  Latency (ms):`);
  console.log(
    `    min ${Math.round(latencies[0] ?? 0)} | p50 ${Math.round(percentile(latencies, 50))} | p95 ${Math.round(percentile(latencies, 95))} | max ${Math.round(latencies[latencies.length - 1] ?? 0)}`,
  );
  console.log(`  Response body (chars):`);
  console.log(
    `    min ${bodySizes[0] ?? 0} | p50 ${percentile(bodySizes, 50)} | p95 ${percentile(bodySizes, 95)} | max ${bodySizes[bodySizes.length - 1] ?? 0}`,
  );

  if (firstErrors.length > 0) {
    console.log(`  First error bodies (up to 5):`);
    for (const e of firstErrors) {
      console.log(`    [${e.status}] ${e.body ?? "(no body)"}`);
    }
  }

  const bad = all.filter((r) => r.status === 0 || r.status >= 500).length;
  return { total: all.length, bad };
}

async function main() {
  const args = parseArgs(process.argv);
  const base = args.base || args["base-url"];
  const token = args.token;
  const concurrency = Number(args.concurrency ?? 30);
  const rounds = Number(args.rounds ?? 1);
  const scenario = String(args.scenario ?? "both").toLowerCase();
  const credsPath = args.creds || args.credentials;
  const strict = args.strict === true;

  if (!base || !token) {
    console.error(
      "Usage: node scripts/stress-share.mjs --base <url> --token <shareToken> [--concurrency 30] [--rounds 1] [--scenario landing|auth|both] [--creds students.csv] [--strict]",
    );
    process.exit(2);
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    console.error("--concurrency must be a positive integer");
    process.exit(2);
  }
  if (!Number.isFinite(rounds) || rounds < 1) {
    console.error("--rounds must be a positive integer");
    process.exit(2);
  }

  const url = `${String(base).replace(/\/$/, "")}/.netlify/functions/supabase-share-bootstrap`;
  const creds = loadCreds(credsPath);
  console.log(`Target: ${url}`);
  console.log(`Token:  ${token}`);
  if (creds.length > 0) {
    console.log(`Creds:  ${creds.length} loaded (cycled if N > creds count)`);
  }

  // Warm-up — Netlify cold start can add seconds to the first request and
  // would skew p95/max if mixed into the measured rounds. One throwaway
  // call lets the function init complete first.
  console.log("\nWarm-up (1 request, not measured)...");
  const warm = await fireOne(url, { shareToken: token });
  console.log(`  warm-up: status ${warm.status} in ${Math.round(warm.elapsed)} ms`);

  let totalBad = 0;
  let totalReq = 0;

  if (scenario === "landing" || scenario === "both") {
    const r = await runScenario({
      url,
      label: "landing (no credentials)",
      concurrency,
      rounds,
      makeBody: () => ({ shareToken: token }),
    });
    totalBad += r.bad;
    totalReq += r.total;
  }

  if (scenario === "auth" || scenario === "both") {
    if (creds.length === 0) {
      console.log("\n=== Scenario: auth — SKIPPED ===");
      console.log(
        "  --creds not provided. Add a CSV of (studentNo,studentCode) pairs to measure the heavier authenticated path that touches 6 child tables per request.",
      );
    } else {
      const r = await runScenario({
        url,
        label: "auth (with credentials)",
        concurrency,
        rounds,
        makeBody: (i) => ({
          shareToken: token,
          studentNo: creds[i % creds.length].studentNo,
          studentCode: creds[i % creds.length].studentCode,
        }),
      });
      totalBad += r.bad;
      totalReq += r.total;
    }
  }

  console.log(`\nSummary: ${totalReq - totalBad}/${totalReq} OK, ${totalBad} 5xx/network-fail.`);
  if (strict && totalBad > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
