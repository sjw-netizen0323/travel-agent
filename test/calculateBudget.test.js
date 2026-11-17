import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateBudget } from "../public/js/calculateBudget.js";

test("카테고리별 합산 + 잔여 예산", () => {
  const r = calculateBudget({
    totalBudget: 800000, people: 2,
    items: [
      { category: "food", label: "식비", amount: 20000, unit: "perPerson", quantity: 3, status: "estimated" },
      { category: "lodging", label: "숙박 2박", amount: 140000, quantity: 2, status: "estimated" },
      { category: "transport", label: "통행료", amount: 15600, status: "confirmed", source: "NAVER Directions 5" },
      { category: "sightseeing", label: "입장료", amount: 3000, unit: "perPerson", status: "confirmed" },
    ],
  });
  assert.equal(r.totals.confirmed, 15600 + 6000);
  assert.equal(r.totals.estimated, 120000 + 280000);
  assert.equal(r.totals.known, 421600);
  assert.equal(r.remaining, 800000 - 421600);
  assert.equal(r.status, "within");
  assert.equal(r.perPerson, 210800);
  assert.deepEqual(r.categories.map((c) => c.key), ["transport", "lodging", "food", "sightseeing"]);
});

test("금액 없는 항목은 '미확인' — 합계에서 제외하고 경고", () => {
  const r = calculateBudget({ totalBudget: 300000, items: [
    { category: "food", label: "식비", amount: 50000 },
    { category: "sightseeing", label: "케이블카", amount: null },
  ] });
  assert.equal(r.totals.known, 50000);
  assert.equal(r.totals.unknownCount, 1);
  assert.equal(r.items[1].statusLabel, "미확인");
  assert.equal(r.items[1].total, null);
  assert.ok(r.warnings.some((w) => w.includes("확인할 수 없는 항목 1개")));
});

test("status 미지정이면 '추정치'로 간주 (확정으로 취급하지 않음)", () => {
  const r = calculateBudget({ totalBudget: 100000, items: [{ category: "food", amount: 10000 }] });
  assert.equal(r.items[0].status, "estimated");
  assert.equal(r.totals.confirmed, 0);
});

test("필수 카테고리가 없으면 미확인 항목 추가", () => {
  const r = calculateBudget({ totalBudget: 500000, items: [{ category: "food", amount: 30000 }], required: ["transport", "lodging", "food"] });
  const missing = r.items.filter((i) => i.status === "unknown").map((i) => i.category);
  assert.deepEqual(missing, ["transport", "lodging"]);
});

test("예산 초과 / 빠듯함 판정", () => {
  assert.equal(calculateBudget({ totalBudget: 100000, items: [{ category: "food", amount: 120000 }] }).status, "over");
  assert.equal(calculateBudget({ totalBudget: 100000, items: [{ category: "food", amount: 95000 }] }).status, "tight");
  const over = calculateBudget({ totalBudget: 100000, items: [{ category: "food", amount: 120000 }] });
  assert.equal(over.remaining, -20000);
});

test("잘못된 입력은 오류", () => {
  assert.throws(() => calculateBudget({ totalBudget: -1 }), TypeError);
  assert.throws(() => calculateBudget({ totalBudget: 1000, people: 0 }), TypeError);
  assert.throws(() => calculateBudget({ totalBudget: 1000, items: [{ category: "food", amount: -5 }] }), TypeError);
});
