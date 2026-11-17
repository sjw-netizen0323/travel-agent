// Agent Loop 오프라인 테스트 — 가짜 OpenAI 클라이언트로 응답 시나리오를 재생합니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTravelAgent, verifyPlan, applyRouteDrives, FUNCTION_TOOLS, PRIVATE } from "../lib/agent.js";

const stop = (o = {}) => ({
  time: "10:00", name: "오죽헌", type: "history", desc: "", address: "", lat: null, lng: null, place_source: "model",
  cost: null, cost_source: "unknown", drive_min: null, drive_km: null, drive_source: "unknown", ...o,
});
const plan = (stops, budget = []) => ({ title: "t", emoji: "🚗", tagline: "", region_note: "", days: [{ title: "d", tip: "", stops }], budget_items: budget, tips: [], references: [] });
const fnCall = (name, args, id) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: id });
const finalMsg = (p) => ({ status: "completed", model: "fake", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(p) }] }], output_text: JSON.stringify(p), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
const callsMsg = (...calls) => ({ status: "completed", model: "fake", output: calls, output_text: "", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });

/** 시나리오대로 응답하고, 받은 요청을 기록하는 가짜 클라이언트 */
function fakeOpenAI(responses) {
  const requests = [];
  return {
    requests,
    responses: { create: async (req) => { requests.push(structuredClone(req)); const r = responses.shift(); if (!r) throw new Error("no more responses"); return typeof r === "function" ? r(req) : r; } },
  };
}

test("함수 스키마 3개 등록 + web_search 포함, tool_choice auto", async () => {
  const client = fakeOpenAI([finalMsg(plan([stop()]))]);
  await runTravelAgent({ openai: client, model: "gpt-5-mini", userPrompt: "x", executors: {} });
  const req = client.requests[0];
  assert.deepEqual(req.tools.filter((t) => t.type === "function").map((t) => t.name), ["search_places", "get_routes", "calculate_budget"]);
  assert.ok(req.tools.some((t) => t.type === "web_search"));
  assert.equal(req.tool_choice, "auto");
  assert.ok(FUNCTION_TOOLS.every((t) => t.strict === true));
});

test("LLM이 Tool을 안 고르면 실행하지 않음 (강제 순서 실행 없음)", async () => {
  const called = [];
  const ex = { search_places: async () => called.push("s"), get_routes: async () => called.push("r"), calculate_budget: async () => called.push("b") };
  const client = fakeOpenAI([finalMsg(plan([stop()]))]);
  const r = await runTravelAgent({ openai: client, model: "m", userPrompt: "x", executors: ex });
  assert.deepEqual(called, []);
  assert.equal(r.meta.turns, 1);
});

test("Tool 호출 → 실제 실행 → 결과를 call_id로 다시 전달 → 추가 호출 → 최종 답변", async () => {
  const executed = [];
  const ex = {
    search_places: async (a) => { executed.push(["search_places", a]); return { query: "강릉 오죽헌", total: 1, places: [{ name: "오죽헌", category: "", address: "강릉시", lat: 37.77922, lng: 128.87753 }] }; },
    get_routes: async (a) => { executed.push(["get_routes", a]); return {
      [PRIVATE]: { paths: [{ from: { lat: 1, lng: 2 }, to: { lat: 37.77922, lng: 128.87753 }, status: "ok", path: [], distance_km: 4.1, duration_min: 7 }] },
      legs: [{ from: "A", to: "B", status: "ok", distance_km: 4.1, duration_min: 7, toll_fare: 0, fuel_price: 543, reason: null }], totals: { distanceKm: 4.1, durationMin: 7 } }; },
  };
  const client = fakeOpenAI([
    callsMsg(fnCall("search_places", { region: "강릉", keyword: "오죽헌" }, "c1")),
    callsMsg(fnCall("get_routes", { legs: [{ from: { name: "A", lat: 1, lng: 2 }, to: { name: "B", lat: 3, lng: 4 } }] }, "c2")),
    finalMsg(plan([stop({ lat: 37.77922, lng: 128.87753, place_source: "search_places", drive_min: 7, drive_km: 4.1, drive_source: "get_routes" })])),
  ]);
  const events = [];
  const r = await runTravelAgent({ openai: client, model: "m", userPrompt: "x", executors: ex, onEvent: (e) => events.push(e) });

  assert.deepEqual(executed.map((e) => e[0]), ["search_places", "get_routes"]);
  const out1 = client.requests[1].input.find((i) => i.type === "function_call_output");
  assert.equal(out1.call_id, "c1");
  assert.equal(JSON.parse(out1.output).places[0].name, "오죽헌");
  assert.ok(client.requests[2].input.some((i) => i.type === "function_call_output" && i.call_id === "c2"));
  assert.equal(r.meta.turns, 3);
  assert.deepEqual(r.meta.tool_calls.map((t) => t.name), ["search_places", "get_routes"]);
  // Tool 결과에 근거한 값은 유지
  const s = r.plan.days[0].stops[0];
  assert.equal(s.drive_min, 7);
  assert.equal(s.lat, 37.77922);
  // Trace 이벤트에 Tool 이름과 결과 요약
  const results = events.filter((e) => e.type === "tool_result");
  assert.deepEqual(results.map((e) => e.name), ["search_places", "get_routes"]);
  assert.match(results[0].summary, /오죽헌/);
});

test("Tool 실행 오류·알 수 없는 Tool은 오류 결과로 LLM에 전달하고 루프 계속", async () => {
  const ex = { search_places: async () => { throw Object.assign(new Error("NAVER 인증 실패"), { code: "auth" }); } };
  const client = fakeOpenAI([
    callsMsg(fnCall("search_places", { region: "a", keyword: "b" }, "c1"), fnCall("hack_tool", {}, "c2")),
    finalMsg(plan([stop()])),
  ]);
  const events = [];
  const r = await runTravelAgent({ openai: client, model: "m", userPrompt: "x", executors: ex, onEvent: (e) => events.push(e) });
  const outs = client.requests[1].input.filter((i) => i.type === "function_call_output");
  assert.equal(outs.length, 2);
  assert.match(JSON.parse(outs[0].output).error, /NAVER 인증 실패/);
  assert.match(JSON.parse(outs[1].output).error, /알 수 없는 Tool/);
  assert.equal(events.filter((e) => e.type === "tool_result" && !e.ok).length, 2);
  assert.ok(r.plan);
});

test("최대 반복 도달 시 tool_choice 'none'으로 최종 답변 강제", async () => {
  const ex = { search_places: async () => ({ query: "q", total: 0, places: [] }) };
  const loop = () => callsMsg(fnCall("search_places", { region: "a", keyword: "b" }, "c" + Math.random()));
  const client = fakeOpenAI([loop, loop, (req) => { assert.equal(req.tool_choice, "none"); return finalMsg(plan([stop()])); }]);
  const events = [];
  const r = await runTravelAgent({ openai: client, model: "m", userPrompt: "x", executors: ex, limits: { maxTurns: 3 }, onEvent: (e) => events.push(e) });
  assert.equal(r.meta.limit_reached, "max_turns");
  assert.ok(events.some((e) => e.type === "limit" && e.reason === "max_turns"));
});

test("Tool 호출 수 한도: 초과분은 실행하지 않고 안내 결과 전달", async () => {
  let n = 0;
  const ex = { search_places: async () => { n++; return { query: "q", total: 0, places: [] }; } };
  const calls = Array.from({ length: 5 }, (_, i) => fnCall("search_places", { region: "a", keyword: "k" + i }, "c" + i));
  const client = fakeOpenAI([callsMsg(...calls), finalMsg(plan([stop()]))]);
  await runTravelAgent({ openai: client, model: "m", userPrompt: "x", executors: ex, limits: { maxCallsPerTurn: 3 } });
  assert.equal(n, 3);
  assert.equal(client.requests[1].input.filter((i) => i.type === "function_call_output").length, 5);
});

test("OpenAI API 오류는 그대로 던짐", async () => {
  const client = { responses: { create: async () => { throw Object.assign(new Error("rate"), { status: 429 }); } } };
  await assert.rejects(runTravelAgent({ openai: client, model: "m", userPrompt: "x", executors: {} }), /rate/);
});

test("get_routes 경로(path)는 LLM에 보내지 않고 최종 결과의 지도용 routes로만 전달", async () => {
  const A = { name: "A", lat: 35.1, lng: 129.1 }, B = { name: "B", lat: 35.2, lng: 129.2 };
  const place = (p) => ({ name: p.name, category: "", address: "", lat: p.lat, lng: p.lng });
  const ex = {
    search_places: async () => ({ query: "q", total: 2, places: [place(A), place(B)] }),
    get_routes: async ({ legs }) => ({
      [PRIVATE]: { paths: [{ from: legs[0].from, to: legs[0].to, status: "ok", path: [[129.1, 35.1], [129.15, 35.15], [129.2, 35.2]], distance_km: 15, duration_min: 20 }] },
      legs: [{ from: "A", to: "B", status: "ok", distance_km: 15, duration_min: 20, toll_fare: 0, fuel_price: 1000, reason: null }],
      totals: { distanceKm: 15, durationMin: 20 },
    }),
  };
  const client = fakeOpenAI([
    callsMsg(fnCall("search_places", { region: "부산", keyword: "x" }, "c0"), fnCall("get_routes", { legs: [{ from: A, to: B }] }, "c1")),
    finalMsg(plan([
      stop({ ...A, place_source: "search_places" }),
      stop({ ...B, place_source: "search_places", drive_min: 20, drive_km: 15, drive_source: "get_routes" }),
    ])),
  ]);
  const r = await runTravelAgent({ openai: client, model: "m", userPrompt: "x", executors: ex });
  const sent = client.requests[1].input.filter((i) => i.type === "function_call_output").map((i) => i.output).join("");
  assert.ok(!sent.includes("129.15"), "경로 좌표가 LLM 입력에 포함되면 안 됨");
  assert.equal(r.meta.routes.length, 1);
  assert.deepEqual(r.meta.routes[0], { day: 0, to: 1, distance_km: 15, duration_min: 20, path: [[129.1, 35.1], [129.15, 35.15], [129.2, 35.2]] });
  assert.equal(r.meta.sources.naver_search.queries[0].query, "q");
  assert.equal(r.meta.sources.naver_directions.legs, 1);
});

test("verifyPlan: 다른 구간의 이동시간을 복사한 경우 제거 (도착 좌표 일치 필요)", () => {
  const A = { lat: 33.5, lng: 126.5 }, B = { lat: 33.46, lng: 126.94 };
  const p = plan([
    stop({ name: "공항", ...A, place_source: "search_places", drive_min: 66, drive_km: 47.5, drive_source: "get_routes" }),
    stop({ name: "성산", ...B, place_source: "search_places", drive_min: 66, drive_km: 47.5, drive_source: "get_routes" }),
  ]);
  const ledger = {
    places: [{ ...A }, { ...B }], legs: [{ duration_min: 66, distance_km: 47.5 }],
    paths: [{ from: A, to: B, duration_min: 66, distance_km: 47.5, path: [] }],
    webSearches: [], webSources: new Set(),
  };
  verifyPlan(p, ledger);
  assert.equal(p.days[0].stops[0].drive_min, null); // 공항은 이 구간의 도착지가 아님
  assert.equal(p.days[0].stops[1].drive_min, 66);
});

test("applyRouteDrives: 실제 계산된 구간 값을 올바른 도착 장소에 채움", () => {
  const p = plan([stop({ name: "A" }), stop({ name: "B" }), stop({ name: "C", drive_min: null })]);
  const filled = applyRouteDrives(p, [{ day: 0, to: 2, duration_min: 25, distance_km: 12.3, path: [] }]);
  assert.equal(filled, 1);
  assert.equal(p.days[0].stops[2].drive_min, 25);
  assert.equal(p.days[0].stops[2].drive_km, 12.3);
  assert.equal(p.days[0].stops[1].drive_min, null); // 경로 없는 구간은 그대로 미확인
});

test("verifyPlan: Tool 결과에 없는 이동시간·좌표·가격은 제거", () => {
  const p = plan(
    [
      stop({ lat: 37.5, lng: 127.0, place_source: "search_places", drive_min: 25, drive_km: 12, drive_source: "get_routes", cost: 5000, cost_source: "web_search" }),
      stop({ drive_min: 9, drive_source: "unknown", cost: 3000, cost_source: "unknown" }),
      stop({ cost: 123, cost_source: "free" }),
    ],
    [
      { key: "lodging", label: "숙박", amount: 150000, status: "estimated", source: "AI" },
      { key: "toll", label: "통행료", amount: 10500, status: "confirmed", source: "get_routes" },
    ],
  );
  p.references = ["https://made-up.example.com"];
  const v = verifyPlan(p, { places: [], legs: [{ duration_min: 7, distance_km: 4.1 }], webSearches: [], webSources: new Set() });
  const [a, b, c] = p.days[0].stops;
  assert.equal(a.lat, null); assert.equal(a.drive_min, null); assert.equal(a.cost, null);
  assert.equal(b.drive_min, null); assert.equal(b.cost, null);
  assert.equal(c.cost, 0);
  assert.equal(p.budget_items[0].amount, null);     // 웹 검색 없는 숙박비 → 미확인
  assert.equal(p.budget_items[0].status, "unknown");
  assert.equal(p.budget_items[1].amount, 10500);    // get_routes 기반 통행료 유지
  assert.deepEqual(p.references, []);
  assert.ok(v.total >= 6);
});
