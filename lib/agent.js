/**
 * 여행 플래너 AI Agent — OpenAI Responses API Function Calling + Agent Loop
 *
 * - 함수 Tool: search_places / get_routes / calculate_budget (Node.js에서 실제 실행)
 * - 내장 Tool: web_search (OpenAI가 실행, 최신 관광 정보용)
 * - LLM이 tool_choice "auto"로 필요한 Tool만 골라 호출합니다. 정해진 순서로 강제 실행하지 않습니다.
 * - 루프: 모델 호출 → function_call 실행 → function_call_output 전달 → 반복 → 최종 JSON 일정
 * - 제한: 최대 반복(turn), 최대 Tool 호출 수, 전체 시간. 넘으면 tool_choice "none"으로 최종 답변만 요청
 * - 검증: 최종 일정의 이동시간·좌표·가격이 실제 Tool 결과에 근거하는지 확인하고, 근거 없는 값은 null(미확인)로 바꿈
 */
import { searchPlaces } from "./searchPlaces.js";
import { getRoutesForLegs } from "./getRoutes.js";
import { calculateBudget } from "../public/js/calculateBudget.js";

export const AGENT_LIMITS = { maxTurns: 10, maxToolCalls: 24, maxCallsPerTurn: 8, deadlineMs: 150_000 };

export class AgentError extends Error {
  constructor(message, code) { super(message); this.name = "AgentError"; this.code = code; }
}

/* ───────────── Tool 스키마 (strict) ───────────── */
const point = {
  type: "object", additionalProperties: false, required: ["name", "lat", "lng"],
  properties: {
    name: { type: "string" },
    lat: { type: "number", description: "WGS84 위도 (search_places 결과 값)" },
    lng: { type: "number", description: "WGS84 경도 (search_places 결과 값)" },
  },
};
const BUDGET_CATS = ["transport", "lodging", "food", "sightseeing", "shopping", "etc", "reserve"];

export const FUNCTION_TOOLS = [
  {
    type: "function",
    name: "search_places",
    description: "NAVER 지역 검색으로 실제 장소(관광지·음식점·카페 등)를 찾습니다. 장소명, 주소, 카테고리, WGS84 좌표를 돌려줍니다. 키워드당 최대 5곳. 영업시간·평점·가격은 제공하지 않습니다.",
    strict: true,
    parameters: {
      type: "object", additionalProperties: false, required: ["region", "keyword"],
      properties: {
        region: { type: "string", description: "여행 지역 (예: 강릉)" },
        keyword: { type: "string", description: "찾을 장소 종류나 이름 (예: 맛집, 오션뷰 카페, 오죽헌)" },
      },
    },
  },
  {
    type: "function",
    name: "get_routes",
    description: "NAVER Directions 5로 두 장소 사이 자동차 이동 거리(km)·시간(분)·통행료·유류비(추정)를 계산합니다. 좌표는 search_places 결과를 사용하세요. 자동차 경로가 없으면 status가 unavailable(확인 불가)입니다. 도보·대중교통은 지원하지 않습니다. 한 번에 최대 12구간.",
    strict: true,
    parameters: {
      type: "object", additionalProperties: false, required: ["legs"],
      properties: {
        legs: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: point, to: point } },
        },
      },
    },
  },
  {
    type: "function",
    name: "calculate_budget",
    description: "예산 항목을 카테고리별로 합산하고 총예산 대비 잔여 예산을 계산합니다(외부 API 없음). 가격 근거가 없는 항목은 amount를 null, status를 unknown으로 넣으세요. Tool이나 웹 검색 결과로 확인한 금액만 confirmed/estimated로 넣습니다.",
    strict: true,
    parameters: {
      type: "object", additionalProperties: false, required: ["total_budget", "people", "items"],
      properties: {
        total_budget: { type: "integer" },
        people: { type: "integer" },
        items: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            required: ["category", "label", "amount", "unit", "quantity", "status", "source"],
            properties: {
              category: { type: "string", enum: BUDGET_CATS },
              label: { type: "string" },
              amount: { type: ["number", "null"], description: "금액(원). 근거 없으면 null" },
              unit: { type: "string", enum: ["total", "perPerson"] },
              quantity: { type: "number" },
              status: { type: "string", enum: ["confirmed", "estimated", "unknown"] },
              source: { type: "string", description: "금액 출처 (예: get_routes, web_search: 사이트명)" },
            },
          },
        },
      },
    },
  },
];

export const WEB_SEARCH_TOOL = { type: "web_search", user_location: { type: "approximate", country: "KR" }, search_context_size: "medium" };

/* ───────────── 최종 일정 스키마 ───────────── */
const STOP_TYPES = ["food", "cafe", "sight", "nature", "rest", "shop", "history", "activity", "lodging"];
const BUDGET_KEYS = ["flight", "ktx", "rental", "fuel", "toll", "lodging", "food", "sight", "cafe", "etc", "reserve"];

export const PLAN_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "emoji", "tagline", "region_note", "days", "budget_items", "tips", "references"],
  properties: {
    title: { type: "string" },
    emoji: { type: "string" },
    tagline: { type: "string" },
    region_note: { type: "string", description: "안내 사항. 없으면 빈 문자열" },
    days: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["title", "tip", "stops"],
        properties: {
          title: { type: "string", description: "그날의 테마 (접두사 없이)" },
          tip: { type: "string" },
          stops: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              required: ["time", "name", "type", "desc", "address", "lat", "lng", "place_source", "cost", "cost_source", "drive_min", "drive_km", "drive_source"],
              properties: {
                time: { type: "string", description: "HH:MM" },
                name: { type: "string" },
                type: { type: "string", enum: STOP_TYPES },
                desc: { type: "string" },
                address: { type: "string", description: "search_places 결과 주소. 없으면 빈 문자열" },
                lat: { type: ["number", "null"], description: "search_places 결과 좌표만. 없으면 null" },
                lng: { type: ["number", "null"] },
                place_source: { type: "string", enum: ["search_places", "model"] },
                cost: { type: ["integer", "null"], description: "1인 비용(원). web_search로 확인한 경우만, 아니면 null" },
                cost_source: { type: "string", enum: ["web_search", "free", "unknown"], description: "free는 무료임이 확인된 경우" },
                drive_min: { type: ["integer", "null"], description: "직전 장소에서의 자동차 이동 시간. get_routes 결과만, 아니면 null" },
                drive_km: { type: ["number", "null"] },
                drive_source: { type: "string", enum: ["get_routes", "unknown"] },
              },
            },
          },
        },
      },
    },
    budget_items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["key", "label", "amount", "status", "source"],
        properties: {
          key: { type: "string", enum: BUDGET_KEYS },
          label: { type: "string" },
          amount: { type: ["integer", "null"], description: "전원 합계(원). 근거 없으면 null" },
          status: { type: "string", enum: ["confirmed", "estimated", "unknown"] },
          source: { type: "string" },
        },
      },
    },
    tips: { type: "array", items: { type: "string" } },
    references: { type: "array", items: { type: "string" }, description: "web_search로 참고한 URL. 없으면 빈 배열" },
  },
};

export const AGENT_INSTRUCTIONS = `당신은 한국 국내 자동차 여행을 계획하는 AI Agent입니다. 사용자의 조건과 요청을 보고 필요한 Tool을 스스로 판단해 사용한 뒤, 최종 일정을 JSON으로 답합니다.

사용 가능한 Tool (필요한 것만, 필요한 만큼 호출하세요. 모든 Tool을 순서대로 다 호출할 필요는 없습니다):
- search_places: 일정에 넣을 실제 장소와 좌표가 필요할 때. 필요한 장소 검색은 한 번의 응답에서 여러 개를 동시에(병렬) 요청하세요. 한 번에 하나씩 나눠 호출하면 반복 횟수가 부족해집니다. 검색어는 "성산일출봉"처럼 장소명이나 짧은 키워드로 쓰세요.
- get_routes: 장소 간 자동차 이동 시간·거리가 필요할 때. search_places에서 받은 좌표로만 호출하세요. 일정의 연속 구간(전날 숙소→다음 날 첫 장소 포함)을 한 번에 묶어서 호출하세요.
- calculate_budget: 확인된 가격들로 합계·잔여 예산을 계산할 때.
- web_search: 최신 정보(입장료, 운영 기간, 축제, 휴관 등)가 필요할 때. 너무 많이 검색하지 마세요.

예산 확인 (매번 반드시 수행):
- 첫 응답에서 search_places와 함께 web_search로 해당 지역의 숙박비 시세(1박 객실 요금, 숙박이 있는 일정일 때)와 1인 식사비 시세를 검색하세요. 한두 번의 검색으로 충분합니다.
- 일정 장소가 정해지면 get_routes를 호출해 통행료·유류비를 확보하세요.
- 숙박비는 (1박 요금 × 박수 × 객실 수), 식비는 (1인 1끼 시세 × 일정의 모든 끼니 수 × 인원)으로 계산해 budget_items에 status "estimated", source에 검색 출처를 넣으세요. 점심 한 끼만 넣지 말고 여행 전체 식비를 하나의 항목으로 넣으세요.
- 관광·입장료(sight)와 카페(cafe)도 웹 검색한 요금이나 지역 평균 시세로 추정해 "estimated"로 넣으세요. 무료 장소만 있으면 0으로 넣으세요. 입장료가 있을 만한 장소는 숙박·식비를 검색할 때 같은 web_search에서 요금도 함께 검색하세요.
- etc(기타) 항목은 근거가 있을 때만 넣고, 없으면 아예 넣지 마세요.
- 이동수단에 맞는 항목만 넣으세요. 자가용이면 rental·ktx·flight 항목은 넣지 마세요. 렌터카를 쓰면 web_search로 하루 대여료 시세를 확인해 rental에 넣으세요.
- reserve(예비비) 항목은 넣지 마세요. 화면에서 자동으로 계산합니다.
- web_search를 했다면 정확한 값이 없어도 검색한 일반 시세로 추정해 "estimated"로 넣으세요. amount null은 어떤 근거로도 추정할 수 없을 때만 쓰세요.

반드시 지킬 규칙:
- Tool 결과에 없는 이동시간·거리는 만들지 마세요. get_routes 결과가 없으면 drive_min/drive_km는 null, drive_source는 "unknown".
- 확인되지 않은 가격은 만들지 마세요. web_search로 확인한 가격만 cost에 넣고(cost_source "web_search"), 무료가 확인되면 0과 "free", 그 외는 null과 "unknown".
- 좌표·주소는 search_places 결과에 있는 값만 쓰세요(place_source "search_places"). 검색하지 않은 장소는 lat/lng null, address 빈 문자열, place_source "model".
- budget_items 금액도 같은 원칙입니다. get_routes의 toll_fare는 confirmed, fuel_price는 estimated, 웹 검색으로 찾은 요금은 estimated(source에 출처), 근거가 없으면 amount null + status "unknown".
- 일정 일수는 요청 기간과 같아야 합니다. 출발지 출발·귀가는 별도 장소로 넣지 말고 tip에 적으세요. 하루 4~6곳, 식사 시간에는 식당을 넣으세요.
- 사용자의 취향과 추가 요청을 반영하세요. 일정과 설명은 한국어로 쓰세요.`;

/* ───────────── Tool 실행기 ───────────── */
/** LLM에는 보내지 않고 서버(화면)에서만 쓰는 데이터 (JSON.stringify가 Symbol 키를 무시함) */
export const PRIVATE = Symbol("private");

/** 기본 실행기 (테스트에서는 가짜 실행기로 교체 가능) */
export const defaultExecutors = {
  async search_places({ region, keyword }) {
    const r = await searchPlaces({ region, keyword, display: 5 });
    return {
      query: r.query,
      total: r.total,
      places: r.places.map((p) => ({ name: p.name, category: p.category, address: p.roadAddress || p.address, lat: p.lat, lng: p.lng })),
    };
  },
  async get_routes({ legs }) {
    const used = legs.slice(0, 12);
    const r = await getRoutesForLegs(used);
    return {
      // 지도용 실제 도로 경로 (LLM 토큰 절약을 위해 LLM에는 보내지 않음)
      [PRIVATE]: { paths: r.legs.map((l, i) => ({ from: used[i].from, to: used[i].to, status: l.status, path: l.path || [], distance_km: l.distanceKm, duration_min: l.durationMin })) },
      legs: r.legs.map((l) => ({
        from: l.from, to: l.to, status: l.status,
        distance_km: l.distanceKm, duration_min: l.durationMin,
        toll_fare: l.tollFare, fuel_price: l.fuelPrice,
        reason: l.reason, note: l.note ?? null,
      })),
      totals: r.totals,
      skipped_legs: Math.max(0, legs.length - 12),
    };
  },
  async calculate_budget({ total_budget, people, items }) {
    const r = calculateBudget({ totalBudget: total_budget, people, items: items.map((it) => ({ ...it, amount: it.amount })) });
    return {
      totals: r.totals, remaining: r.remaining, status: r.status, per_person: r.perPerson,
      categories: r.categories.map((c) => ({ category: c.key, total: c.total, confirmed: c.confirmed, estimated: c.estimated, unknown_count: c.unknownCount })),
      warnings: r.warnings,
    };
  },
};

/** Trace용 결과 요약 (사람이 읽는 한 줄) */
export function summarizeToolResult(name, args, result) {
  if (result?.error) return `오류: ${result.error}`;
  switch (name) {
    case "search_places":
      return `"${result.query}" → ${result.places.length}곳${result.places.length ? `: ${result.places.slice(0, 3).map((p) => p.name).join(", ")}${result.places.length > 3 ? " 외" : ""}` : ""}`;
    case "get_routes": {
      const ok = result.legs.filter((l) => l.status === "ok");
      const na = result.legs.length - ok.length;
      return `${result.legs.length}구간 중 ${ok.length}구간 확인 · ${result.totals.distanceKm}km · ${result.totals.durationMin}분${na ? ` · 확인 불가 ${na}구간` : ""}`;
    }
    case "calculate_budget":
      return `합계 ${result.totals.known.toLocaleString()}원 (확인됨 ${result.totals.confirmed.toLocaleString()} · 추정 ${result.totals.estimated.toLocaleString()} · 미확인 ${result.totals.unknownCount}건) · 잔여 ${result.remaining.toLocaleString()}원`;
    default:
      return "완료";
  }
}

/* ───────────── Agent Loop ───────────── */
/**
 * @param {object} p
 * @param {import('openai').default} p.openai
 * @param {string} p.model
 * @param {string} p.userPrompt   사용자 조건(JSON 문자열 포함)
 * @param {(ev:object)=>void} [p.onEvent]  Trace 이벤트 콜백
 * @param {object} [p.executors]  Tool 실행기 (기본: 실제 API)
 * @param {object} [p.limits]
 * @param {boolean} [p.webSearch=true]
 */
export async function runTravelAgent({ openai, model, userPrompt, onEvent = () => {}, executors = defaultExecutors, limits = {}, webSearch = true, signal }) {
  const L = { ...AGENT_LIMITS, ...limits };
  const started = Date.now();
  const tools = [...FUNCTION_TOOLS, ...(webSearch ? [WEB_SEARCH_TOOL] : [])];
  const isReasoning = /^(gpt-5|o\d)/i.test(model);
  const ledger = { places: [], placeQueries: [], legs: [], paths: [], webSearches: [], webSources: new Set(), toolCalls: [] };
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const input = [{ role: "user", content: userPrompt }];
  let toolCallCount = 0;

  for (let turn = 1; turn <= L.maxTurns; turn++) {
    if (signal?.aborted) throw new AgentError("요청이 취소됐어요.", "aborted");
    const elapsed = Date.now() - started;
    const limitReason = turn === L.maxTurns ? "max_turns" : toolCallCount >= L.maxToolCalls ? "max_tool_calls" : elapsed > L.deadlineMs ? "deadline" : null;
    const forceFinal = !!limitReason;
    if (forceFinal) onEvent({ type: "limit", reason: limitReason, turn });

    onEvent({ type: "model_start", turn, forceFinal });
    const t0 = Date.now();
    const response = await openai.responses.create({
      model,
      instructions: AGENT_INSTRUCTIONS,
      input,
      tools,
      tool_choice: forceFinal ? "none" : "auto",
      parallel_tool_calls: true,
      text: { format: { type: "json_schema", name: "travel_plan", strict: true, schema: PLAN_SCHEMA } },
      include: [...(isReasoning ? ["reasoning.encrypted_content"] : []), ...(webSearch ? ["web_search_call.action.sources"] : [])],
      ...(isReasoning ? { reasoning: { effort: "low" } } : {}),
      store: false,
    }, { signal });
    for (const k of Object.keys(usage)) usage[k] += response.usage?.[k] ?? 0;

    const output = response.output || [];
    input.push(...output); // 모델 출력(추론·함수 호출·웹 검색 기록)을 다음 요청에 그대로 이어 붙임

    // 내장 web_search 기록 (OpenAI가 실행함)
    for (const ws of output.filter((o) => o.type === "web_search_call")) {
      const queries = ws.action?.queries || (ws.action?.query ? [ws.action.query] : []);
      const sources = (ws.action?.sources || []).map((s) => s.url).filter(Boolean);
      sources.forEach((u) => ledger.webSources.add(u));
      ledger.webSearches.push({ queries, status: ws.status, action: ws.action?.type });
      onEvent({ type: "web_search", turn, action: ws.action?.type, queries, url: ws.action?.url ?? null, sources: sources.slice(0, 5), status: ws.status });
    }

    const calls = output.filter((o) => o.type === "function_call");
    onEvent({ type: "model_done", turn, ms: Date.now() - t0, functionCalls: calls.map((c) => c.name), webSearches: output.filter((o) => o.type === "web_search_call").length, status: response.status });

    if (response.status === "incomplete") throw new AgentError("AI 응답이 중간에 끊겼어요. 기간을 줄이거나 다시 시도해 주세요.", "incomplete");

    if (!calls.length) {
      const refusal = output.flatMap((o) => o.content || []).find((c) => c.type === "refusal");
      if (refusal) throw new AgentError("AI가 이 요청에 대한 일정 생성을 거절했어요.", "refusal");
      let plan;
      try { plan = JSON.parse(response.output_text); } catch { throw new AgentError("AI 최종 응답을 해석하지 못했어요.", "bad_json"); }
      // 웹 검색 인용(url_citation)도 실제 출처로 인정
      for (const c of output.flatMap((o) => o.content || [])) {
        for (const a of c.annotations || []) if (a.type === "url_citation" && a.url) ledger.webSources.add(a.url);
      }
      const verification = verifyPlan(plan, ledger);
      const routes = buildRouteOverlays(plan, ledger);
      verification.filled = applyRouteDrives(plan, routes);
      onEvent({ type: "final", turn, verification, routes: routes.length });
      return {
        plan,
        meta: {
          model: response.model, turns: turn, tool_calls: ledger.toolCalls, web_searches: ledger.webSearches.length,
          limit_reached: limitReason, duration_ms: Date.now() - started, usage, verification,
          routes, // 지도에 그릴 실제 자동차 경로 (get_routes 결과 중 일정 구간과 일치하는 것만)
          sources: {
            naver_search: { name: "NAVER API HUB 지역 검색", queries: ledger.placeQueries },
            naver_directions: { name: "NAVER Maps Directions 5", legs: ledger.legs.length },
            web: [...ledger.webSources].slice(0, 20),
            web_queries: ledger.webSearches.flatMap((w) => w.queries).slice(0, 10),
          },
        },
      };
    }

    // 함수 호출 실행 (턴당·전체 한도 적용). 모든 call_id에는 반드시 output을 돌려줘야 함
    const outputs = await Promise.all(calls.map(async (call, idx) => {
      const id = call.call_id;
      if (idx >= L.maxCallsPerTurn || toolCallCount + idx >= L.maxToolCalls) {
        const result = { error: "Tool 호출 한도를 넘어 실행하지 않았어요. 지금까지의 결과로 일정을 완성하세요." };
        onEvent({ type: "tool_skipped", turn, id, name: call.name });
        return { type: "function_call_output", call_id: id, output: JSON.stringify(result) };
      }
      let args;
      try { args = JSON.parse(call.arguments || "{}"); } catch { args = null; }
      onEvent({ type: "tool_call", turn, id, name: call.name, args });
      const ts = Date.now();
      let result, ok = true;
      const exec = executors[call.name];
      try {
        if (!exec) throw new Error(`알 수 없는 Tool: ${call.name}`);
        if (!args) throw new Error("Tool 인자를 해석하지 못했어요.");
        result = await exec(args);
      } catch (err) {
        ok = false;
        result = { error: err?.message || String(err), code: err?.code ?? null };
      }
      recordLedger(ledger, call.name, args, result);
      ledger.toolCalls.push({ name: call.name, ok, ms: Date.now() - ts });
      onEvent({ type: "tool_result", turn, id, name: call.name, ok, ms: Date.now() - ts, summary: summarizeToolResult(call.name, args, result) });
      return { type: "function_call_output", call_id: id, output: JSON.stringify(result) };
    }));
    toolCallCount += calls.length;
    input.push(...outputs);
  }
  throw new AgentError("최대 반복 횟수 안에 일정을 완성하지 못했어요.", "max_turns");
}

function recordLedger(ledger, name, args, result) {
  if (!result || result.error) return;
  if (name === "search_places") {
    ledger.places.push(...result.places.filter((p) => p.lat !== null && p.lng !== null));
    ledger.placeQueries.push({ query: result.query, count: result.places.length });
  }
  if (name === "get_routes") {
    ledger.legs.push(...result.legs.filter((l) => l.status === "ok"));
    ledger.paths.push(...(result[PRIVATE]?.paths || []).filter((p) => p.status === "ok"));
  }
}

/**
 * 최종 일정의 연속 장소(직전 → 현재)와 좌표가 일치하는 get_routes 결과를 찾아 지도용 경로를 붙입니다.
 * 실제로 계산된 구간만 포함하며, 없는 구간은 그리지 않습니다.
 */
export function buildRouteOverlays(plan, ledger) {
  const near = (a, b) => a && b && Math.abs(a.lat - b.lat) <= 0.0005 && Math.abs(a.lng - b.lng) <= 0.0005;
  const routes = [];
  const earlier = []; // 일정 순서상 앞에 나온, 좌표가 있는 장소들 (전날 숙소·좌표 없는 장소를 건너뛴 구간도 찾기 위해)
  (plan.days || []).forEach((day, di) => {
    (day.stops || []).forEach((s, si) => {
      if (s.lat !== null && s.lng !== null) {
        // 가장 가까운(최근) 앞 장소부터 일치하는 실제 경로를 찾음
        const leg = [...earlier].reverse().map((prev) => ledger.paths.find((p) => near(p.from, prev) && near(p.to, s))).find(Boolean);
        if (leg && leg.path.length >= 2) routes.push({ day: di, to: si, distance_km: leg.distance_km, duration_min: leg.duration_min, path: leg.path });
        earlier.push(s);
      }
    });
  });
  return routes;
}

/**
 * 실제 계산된 구간(routes)의 도착 장소에 그 구간의 이동시간·거리를 채웁니다.
 * (LLM이 값을 다른 장소에 잘못 붙여 검증에서 지워진 경우에도, 실제 get_routes 결과를 올바른 장소에 표시)
 * @returns 새로 채우거나 바로잡은 장소 수
 */
export function applyRouteDrives(plan, routes) {
  let filled = 0;
  for (const r of routes) {
    const s = plan.days?.[r.day]?.stops?.[r.to];
    if (!s || r.duration_min === null || r.duration_min === undefined) continue;
    if (s.drive_min !== r.duration_min || s.drive_km !== r.distance_km || s.drive_source !== "get_routes") filled++;
    s.drive_min = r.duration_min;
    s.drive_km = r.distance_km;
    s.drive_source = "get_routes";
  }
  return filled;
}

/* ───────────── 최종 일정 검증 (근거 없는 값 제거) ───────────── */
/**
 * plan을 제자리에서 수정하고, 바뀐 내역을 돌려줍니다.
 * - 좌표: search_places 결과와 일치(±0.0005°)하지 않으면 null
 * - 이동시간: get_routes 결과(±1분, ±0.3km)와 일치하지 않으면 null
 * - 가격: web_search를 한 번도 안 했는데 web_search 출처라고 하면 null
 * - 예산: 통행료·유류비는 get_routes 없이 금액이 있으면 미확인, 그 외 금액은 web_search 없이 있으면 미확인
 * - 참고 URL: 실제 web_search 출처에 없는 URL 제거
 */
export function verifyPlan(plan, ledger) {
  const fixes = { coords: 0, drives: 0, costs: 0, budget: 0, references: 0 };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const usedWeb = ledger.webSearches.length > 0;
  const usedRoutes = ledger.legs.length > 0;

  for (const day of plan.days || []) {
    for (const s of day.stops || []) {
      const coordOk = s.lat !== null && s.lng !== null && s.place_source === "search_places"
        && ledger.places.some((p) => near(p.lat, s.lat, 0.0005) && near(p.lng, s.lng, 0.0005));
      if (!coordOk && (s.lat !== null || s.lng !== null)) fixes.coords++;
      if (!coordOk) { s.lat = null; s.lng = null; if (s.place_source === "search_places") s.place_source = "model"; }
      if (!coordOk && s.place_source === "model") s.address = s.address && ledger.places.some((p) => p.address === s.address) ? s.address : "";

      // 이동시간: 이 장소가 "도착지"인 실제 get_routes 구간과 시간·거리가 일치해야 함 (다른 구간 값 복사 방지)
      const sameLeg = (l) => near(l.duration_min, s.drive_min, 1) && (s.drive_km === null || near(l.distance_km, s.drive_km, 0.3));
      const driveOk = s.drive_source === "get_routes" && s.drive_min !== null && (
        ledger.paths
          ? coordOk && ledger.paths.some((p) => p.to && near(p.to.lat, s.lat, 0.0005) && near(p.to.lng, s.lng, 0.0005) && sameLeg(p))
          : ledger.legs.some(sameLeg));
      if (!driveOk && (s.drive_min !== null || s.drive_km !== null)) fixes.drives++;
      if (!driveOk) { s.drive_min = null; s.drive_km = null; s.drive_source = "unknown"; }

      if (s.cost_source === "web_search" && !usedWeb) { fixes.costs++; s.cost = null; s.cost_source = "unknown"; }
      if (s.cost_source === "unknown" && s.cost !== null) { fixes.costs++; s.cost = null; }
      if (s.cost_source === "free") s.cost = 0;
    }
  }

  for (const it of plan.budget_items || []) {
    if (it.amount === null) { it.status = "unknown"; continue; }
    const routeKey = it.key === "toll" || it.key === "fuel";
    const grounded = routeKey ? usedRoutes || usedWeb : usedWeb;
    if (!grounded || it.status === "unknown") { fixes.budget++; it.amount = null; it.status = "unknown"; continue; }
    // 유류비는 NAVER도 평균 유가 기반 추정치 → 확인됨으로 표시하지 않음
    if (it.key === "fuel" && it.status === "confirmed") { fixes.budget++; it.status = "estimated"; }
  }

  // 참고 URL: "https://… (설명)." 같은 형식에서 URL만 꺼내고, 실제 웹 검색 출처와 일치하는 것만 남김
  const refs = Array.isArray(plan.references) ? plan.references : [];
  const sources = [...ledger.webSources];
  const clean = refs
    .map((r) => (String(r).match(/https?:\/\/[^\s)<>"']+/) || [""])[0].replace(/[.,;:]+$/, ""))
    .map((u) => (u && (ledger.webSources.has(u) ? u : sources.find((s) => s.startsWith(u) || u.startsWith(s)))) || null);
  plan.references = [...new Set(clean.filter(Boolean))];
  fixes.references = refs.length - clean.filter(Boolean).length;

  return { fixes, total: Object.values(fixes).reduce((a, b) => a + b, 0) };
}
