/**
 * bitpos — fixed virtual 256-bit area space (Phase 1 Step 5).
 *
 * The pilot's area space is 256 bits partitioned into four domains. This is NOT a
 * real AST mapping; it is a fixed demonstration space sized for readable heatmaps.
 * Production uses a tag-set + versioned dictionary (LIGHTHOUSE_MODEL.md §6).
 *
 *   bit   0– 31  →  "auth"     critical
 *   bit  32– 63  →  "payment"  critical
 *   bit  64–127  →  "ui"       normal
 *   bit 128–255  →  "utils"    low
 */

export type DomainName = "auth" | "payment" | "ui" | "utils";
export type DomainWeight = "critical" | "normal" | "low";

export interface Domain {
  name: DomainName;
  startBit: number;
  endBit: number;      // inclusive
  bitCount: number;
  weight: DomainWeight;
}

export const DOMAINS: readonly Domain[] = [
  { name: "auth",    startBit:   0, endBit:  31, bitCount:  32, weight: "critical" },
  { name: "payment", startBit:  32, endBit:  63, bitCount:  32, weight: "critical" },
  { name: "ui",      startBit:  64, endBit: 127, bitCount:  64, weight: "normal"   },
  { name: "utils",   startBit: 128, endBit: 255, bitCount: 128, weight: "low"      },
] as const;

export const TOTAL_BITS = 256;

/** Target coverage requirements (§4 of PILOT_DATA.md). */
export const TARGET_COVERAGE: Record<DomainName, number> = {
  auth:    32,  // all bits required
  payment: 32,  // all bits required
  ui:      48,  // 48 of 64 required
  utils:   32,  // 32 of 128 required (low-priority)
};

/** Returns the Domain that contains a given bit position, or undefined. */
export function domainOfBit(bit: number): Domain | undefined {
  return DOMAINS.find((d) => bit >= d.startBit && bit <= d.endBit);
}

/** Returns the domain name for a bit position, or null if out of range. */
export function domainNameOfBit(bit: number): DomainName | null {
  return domainOfBit(bit)?.name ?? null;
}

/**
 * Roll up a list of bit positions to per-domain counts.
 * Bits outside [0, 255] are silently ignored.
 */
export function rollUpToDomains(bits: number[]): Record<DomainName, number> {
  const counts: Record<DomainName, number> = { auth: 0, payment: 0, ui: 0, utils: 0 };
  for (const b of bits) {
    const name = domainNameOfBit(b);
    if (name) counts[name]++;
  }
  return counts;
}

/**
 * Given a set of bits observed (across any number of events), compute the
 * per-domain coverage: how many distinct bits in each domain were touched.
 */
export function computeCoverage(allBits: number[]): Record<DomainName, number> {
  const seen = new Set<number>(allBits.filter((b) => b >= 0 && b < TOTAL_BITS));
  const result: Record<DomainName, number> = { auth: 0, payment: 0, ui: 0, utils: 0 };
  for (const b of seen) {
    const name = domainNameOfBit(b);
    if (name) result[name]++;
  }
  return result;
}

/**
 * Check which domains are below their target coverage requirement.
 * Returns domain names that have a gap, sorted by weight (critical first).
 */
export function coverageGaps(
  covered: Record<DomainName, number>,
): Array<{ domain: DomainName; covered: number; required: number; gap: number }> {
  return DOMAINS.filter((d) => covered[d.name] < TARGET_COVERAGE[d.name])
    .map((d) => ({
      domain: d.name,
      covered: covered[d.name],
      required: TARGET_COVERAGE[d.name],
      gap: TARGET_COVERAGE[d.name] - covered[d.name],
    }));
}

/**
 * Generate `n` random bit positions biased toward critical domains.
 * Used by the mock generator to build realistic `areas` arrays.
 *
 * domainBias: weight multiplier per domain (default: critical=3, normal=2, low=1).
 */
export function randomBits(
  n: number,
  domainBias: Partial<Record<DomainName, number>> = {},
  rng: () => number = Math.random,
): number[] {
  const defaultBias: Record<DomainName, number> = {
    auth: 3, payment: 3, ui: 2, utils: 1,
  };
  const bias = { ...defaultBias, ...domainBias };

  // Build a weighted domain list
  const pool: Domain[] = [];
  for (const d of DOMAINS) {
    const w = Math.round(bias[d.name] ?? 1);
    for (let i = 0; i < w; i++) pool.push(d);
  }

  const chosen = new Set<number>();
  let attempts = 0;
  while (chosen.size < n && attempts < n * 10) {
    const d = pool[Math.floor(rng() * pool.length)];
    const bit = d.startBit + Math.floor(rng() * d.bitCount);
    chosen.add(bit);
    attempts++;
  }
  return [...chosen];
}
