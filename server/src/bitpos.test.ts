/** bitpos unit tests (Phase 1 Step 5). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  domainNameOfBit, rollUpToDomains, computeCoverage, coverageGaps,
  randomBits, DOMAINS, TARGET_COVERAGE, TOTAL_BITS,
} from "./bitpos.js";

describe("bitpos — domain lookup", () => {
  it("maps boundary bits to their domains", () => {
    assert.equal(domainNameOfBit(0),   "auth");
    assert.equal(domainNameOfBit(31),  "auth");
    assert.equal(domainNameOfBit(32),  "payment");
    assert.equal(domainNameOfBit(63),  "payment");
    assert.equal(domainNameOfBit(64),  "ui");
    assert.equal(domainNameOfBit(127), "ui");
    assert.equal(domainNameOfBit(128), "utils");
    assert.equal(domainNameOfBit(255), "utils");
  });

  it("returns null for out-of-range bits", () => {
    assert.equal(domainNameOfBit(-1), null);
    assert.equal(domainNameOfBit(256), null);
  });

  it("covers exactly 256 bits across all domains", () => {
    const total = DOMAINS.reduce((s, d) => s + d.bitCount, 0);
    assert.equal(total, TOTAL_BITS);
  });
});

describe("bitpos — rollUpToDomains", () => {
  it("counts occurrences per domain (not distinct)", () => {
    const counts = rollUpToDomains([0, 0, 1, 32, 64]);
    assert.equal(counts.auth, 3);   // bits 0,0,1
    assert.equal(counts.payment, 1);
    assert.equal(counts.ui, 1);
    assert.equal(counts.utils, 0);
  });
});

describe("bitpos — computeCoverage", () => {
  it("counts distinct bits per domain", () => {
    const cov = computeCoverage([0, 0, 1, 32]);
    assert.equal(cov.auth, 2);    // bits 0 and 1 (0 deduped)
    assert.equal(cov.payment, 1);
  });
});

describe("bitpos — coverageGaps", () => {
  it("returns gaps sorted by coverage shortfall", () => {
    const gaps = coverageGaps({ auth: 0, payment: 32, ui: 48, utils: 32 });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].domain, "auth");
    assert.equal(gaps[0].gap, 32);
  });

  it("returns empty when all domains meet target", () => {
    const gaps = coverageGaps({ auth: 32, payment: 32, ui: 48, utils: 32 });
    assert.deepEqual(gaps, []);
  });

  it("reports utils gap when under 32 bits", () => {
    const gaps = coverageGaps({ auth: 32, payment: 32, ui: 48, utils: 10 });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].domain, "utils");
    assert.equal(gaps[0].gap, TARGET_COVERAGE.utils - 10);
  });
});

describe("bitpos — randomBits", () => {
  it("returns the requested count of distinct bits", () => {
    const bits = randomBits(5);
    assert.equal(new Set(bits).size, bits.length);
    assert.equal(bits.length, 5);
  });

  it("all returned bits are in [0, 255]", () => {
    const bits = randomBits(20);
    for (const b of bits) {
      assert.ok(b >= 0 && b < TOTAL_BITS, `bit ${b} out of range`);
    }
  });

  it("bias toward auth increases auth frequency over many samples", () => {
    // Generate 200 bits with heavy auth bias; expect >50% in auth domain
    let authCount = 0;
    const total = 200;
    for (let i = 0; i < total; i++) {
      const [b] = randomBits(1, { auth: 10, payment: 1, ui: 1, utils: 1 });
      if (b !== undefined && b <= 31) authCount++;
    }
    assert.ok(authCount > total * 0.4, `expected auth-heavy, got ${authCount}/${total}`);
  });
});
