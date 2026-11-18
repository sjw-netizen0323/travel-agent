import { test } from "node:test";
import assert from "node:assert/strict";
import { addRoundTripCosts } from "../lib/roundTrip.js";

const plan = () => ({
  days: [{ stops: [{ name: "A", lat: 37.7, lng: 128.9 }] }, { stops: [{ name: "B", lat: 37.8, lng: 128.9 }, { name: "C", lat: null, lng: null }] }],
  budget_items: [{ key: "fuel", label: "유류비", amount: 10000, status: "estimated", source: "get_routes" }],
});
const search = async () => ({ places: [{ lat: 37.5, lng: 127.0 }, { lat: 37.6, lng: 127.1 }] });
const okRoutes = async (legs) => ({ legs, totals: { ok: legs.length, distanceKm: 460.4, durationMin: 330, fuelPrice: 60000, tollFare: 19000 } });
const input = { origin: "서울", region: "강릉", transport: "own", toll: true };

test("자가용: 왕복 유류비·통행료를 예산에 더하고 기존 항목은 현지 이동으로 표시", async () => {
  const p = plan();
  const r = await addRoundTripCosts(p, input, { search, routes: okRoutes });
  assert.equal(r.fuelPrice, 60000);
  assert.equal(p.budget_items[0].label, "현지 이동 유류비");
  assert.deepEqual(p.budget_items.slice(1).map((b) => [b.key, b.amount]), [["fuel", 60000], ["toll", 19000]]);
});

test("왕복 구간은 첫날 첫 장소와 마지막 날 좌표 있는 마지막 장소", async () => {
  let got;
  await addRoundTripCosts(plan(), input, { search, routes: async (legs) => { got = legs; return okRoutes(legs); } });
  assert.equal(got[0].to.name, "A");
  assert.equal(got[1].from.name, "B");
});

test("렌터카·KTX면 계산하지 않음", async () => {
  assert.equal(await addRoundTripCosts(plan(), { ...input, transport: "rental" }, { search, routes: okRoutes }), null);
});

test("통행료 제외 옵션이면 통행료 항목을 넣지 않음", async () => {
  const p = plan();
  await addRoundTripCosts(p, { ...input, toll: false }, { search, routes: okRoutes });
  assert.equal(p.budget_items.filter((b) => b.key === "toll").length, 0);
});

test("중심 좌표 경로 실패 시 첫 검색 결과로 재시도, 둘 다 실패면 null", async () => {
  let calls = 0;
  const fail = async (legs) => { calls++; return { legs, totals: { ok: 1 } }; };
  assert.equal(await addRoundTripCosts(plan(), input, { search, routes: fail }), null);
  assert.equal(calls, 2);
});
