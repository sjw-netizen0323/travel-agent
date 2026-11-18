import { test } from "node:test";
import assert from "node:assert/strict";
import { findPlanGaps } from "../lib/agent.js";

const ledger = (places = 1, legs = 1) => ({ places: Array(places).fill({}), legs: Array(legs).fill({}) });
const plan = (days, budget) => ({ days, budget_items: budget });
const ok = [{ key: "lodging", amount: 200000 }, { key: "food", amount: 100000 }];

test("빠진 부분이 없으면 빈 배열", () => {
  assert.deepEqual(findPlanGaps(plan([{}], ok), ledger()), []);
});

test("일정이 비어 있으면 보완 요청", () => {
  assert.equal(findPlanGaps(plan([], ok), ledger()).length, 1);
});

test("장소는 찾았는데 get_routes를 안 했으면 보완 요청", () => {
  assert.match(findPlanGaps(plan([{}], ok), ledger(3, 0))[0], /get_routes/);
});

test("숙박비·식비가 비어 있으면 보완 요청", () => {
  const gaps = findPlanGaps(plan([{}], [{ key: "lodging", amount: null }, { key: "food", amount: null }, { key: "sight", amount: null }]), ledger());
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /숙박비·식비/);
});
