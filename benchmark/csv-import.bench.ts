// Throughput benchmark for the CSV import parse + validate path
// (`parseImportCsv`), the one hot path that is measurable without a live store.
// Run with: npm run bench
//
// Reports the median of ITERATIONS timed runs after WARMUP untimed runs. Sizes
// stop at the 5,000-row job cap because the parser rejects anything larger.

import { describe, expect, it } from "vitest";

import { generateImportCsv } from "./generate-csv";

import { parseImportCsv } from "~/lib/csv.server";

const SIZES = [1000, 2500, 5000];
const WARMUP = 5;
const ITERATIONS = 25;

function timeParse(csv: string, runs: number): number[] {
  const samples: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const start = performance.now();
    const result = parseImportCsv(csv);
    // Guard against benchmarking a rejected file (which would exit early and
    // report a meaningless number).
    if (!result.ok || result.invalidRows.length > 0) {
      throw new Error(`benchmark input was not fully valid: ${result.error ?? "invalid rows"}`);
    }
    samples.push(performance.now() - start);
  }
  return samples;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("parseImportCsv throughput", () => {
  it("measures rows/sec across file sizes up to the job cap", () => {
    const table = SIZES.map((rows) => {
      const csv = generateImportCsv({ rows });
      timeParse(csv, WARMUP);
      const samples = timeParse(csv, ITERATIONS);
      const medianMs = median(samples);

      return {
        rows,
        kb: Math.round(Buffer.byteLength(csv) / 1024),
        medianMs: Number(medianMs.toFixed(2)),
        rowsPerSec: Math.round(rows / (medianMs / 1000)),
      };
    });

    // eslint-disable-next-line no-console
    console.table(table);
    expect(table).toHaveLength(SIZES.length);
  }, 120_000);
});
