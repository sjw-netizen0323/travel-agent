/**
 * 여행 플래너 서버
 * - public/ 폴더의 프론트엔드만 정적으로 제공합니다. (.env 등 루트 파일은 절대 노출되지 않음)
 * - POST /api/plan   : Function Calling AI Agent 실행. 진행 상황(Agent Trace)을 NDJSON으로 스트리밍
 * - GET  /api/places : NAVER 지역 검색 (화면의 장소 검색 패널용)
 * - POST /api/routes : NAVER 자동차 경로 (화면의 "경로 계산" 버튼용)
 * - API Key는 서버에서만 읽고 사용하며, 응답에도 포함하지 않습니다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";
import { searchPlacesMulti, NaverApiError } from "./lib/searchPlaces.js";
import { getRoutes, NaverMapsError } from "./lib/getRoutes.js";
import { runTravelAgent, AgentError } from "./lib/agent.js";
import { addRoundTripCosts } from "./lib/roundTrip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env"), quiet: true });

const PORT = Number(process.env.PORT) || 3000;
const MODEL = (process.env.OPENAI_MODEL || "").trim();
const API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const WEB_SEARCH = process.env.AGENT_WEB_SEARCH !== "off"; // 내장 web_search 사용 여부 (기본 사용)

const openai = API_KEY ? new OpenAI({ apiKey: API_KEY, timeout: 90_000, maxRetries: 2 }) : null;

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ───────────── 입력 검증 ───────────── */
const PREFS = ["맛집", "관광", "자연", "휴식", "쇼핑", "카페", "역사", "액티비티"];
const TRANSPORTS = { own: "자가용(출발지에서 직접 운전)", rental: "렌터카(현지 도착 후 대여)", "ktx-rental": "KTX로 이동 후 현지 렌터카" };

function validateInput(body) {
  const errors = [];
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

  const input = {
    region: str(body.region, 40),
    startDate: str(body.startDate, 10),
    duration: int(body.duration),
    people: int(body.people),
    budget: int(body.budget),
    prefs: Array.isArray(body.prefs) ? body.prefs.filter((p) => PREFS.includes(p)) : [],
    transport: Object.hasOwn(TRANSPORTS, body.transport) ? body.transport : "own",
    origin: str(body.origin, 40) || "서울",
    parking: body.parking !== false,
    toll: body.toll !== false,
    notes: str(body.notes, 500),
  };

  if (!input.region) errors.push("여행 지역을 입력해 주세요.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) errors.push("출발일 형식이 올바르지 않아요.");
  if (!(input.duration >= 1 && input.duration <= 5)) errors.push("여행 기간은 당일~4박 5일 사이로 골라 주세요.");
  if (!(input.people >= 1 && input.people <= 12)) errors.push("인원은 1~12명 사이로 입력해 주세요.");
  if (!(input.budget >= 10_000 && input.budget <= 100_000_000)) errors.push("총예산은 1만 원 이상으로 입력해 주세요.");
  return { input, errors };
}

function buildUserPrompt(input) {
  const nights = input.duration - 1;
  const conditions = {
    region: input.region,
    start_date: input.startDate,
    days: input.duration,
    trip_length: nights === 0 ? "당일치기" : `${nights}박 ${input.duration}일`,
    people: input.people,
    total_budget_krw: input.budget,
    preferences: input.prefs.length ? input.prefs : ["특별한 선호 없음"],
    transport: TRANSPORTS[input.transport],
    origin: input.origin,
    prefer_easy_parking: input.parking,
    include_tolls: input.toll,
    extra_request: input.notes || "없음",
  };
  return `다음 조건으로 국내 자동차 여행 일정을 만들어 주세요. 필요한 Tool을 골라 사용하세요.\n${JSON.stringify(conditions, null, 2)}`;
}

/* ───────────── API ───────────── */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true, model: MODEL || null, configured: Boolean(API_KEY && MODEL), web_search: WEB_SEARCH,
    naver_search: Boolean(process.env.NAVER_API_HUB_CLIENT_ID && process.env.NAVER_API_HUB_CLIENT_SECRET),
    naver_maps: Boolean(process.env.NAVER_MAPS_CLIENT_ID && process.env.NAVER_MAPS_CLIENT_SECRET),
  });
});

/**
 * GET /api/config — 브라우저에 필요한 공개 설정
 * NAVER Maps Web Dynamic Map은 스크립트 URL에 Client ID(ncpKeyId)를 넣는 방식이라 ID는 원래 공개값입니다.
 * (도용 방지는 NCP 콘솔의 "Web 서비스 URL" 등록으로 함) Client Secret은 절대 보내지 않습니다.
 */
app.get("/api/config", (_req, res) => {
  res.json({ naverMapsKeyId: (process.env.NAVER_MAPS_CLIENT_ID || "").trim() || null });
});

/**
 * POST /api/routes  { days: [[{name,lat,lng}, ...], ...] }
 * 날짜별 연속 구간의 자동차 경로(get_routes, NAVER Directions 5)를 계산합니다.
 */
app.post("/api/routes", async (req, res) => {
  const days = Array.isArray(req.body?.days) ? req.body.days.slice(0, 6) : null;
  if (!days || !days.length) return res.status(400).json({ error: "경로를 계산할 장소 목록이 없어요.", code: "invalid_input" });
  const clean = days.map((stops) => (Array.isArray(stops) ? stops.slice(0, 10) : []).map((s) => ({
    name: String(s?.name ?? "").slice(0, 60),
    lat: typeof s?.lat === "number" ? s.lat : null,
    lng: typeof s?.lng === "number" ? s.lng : null,
  })));

  const started = Date.now();
  try {
    const results = [];
    for (const stops of clean) results.push(stops.length >= 2 ? await getRoutes(stops) : { legs: [], totals: null });
    res.json({ days: results, meta: { source: "NAVER Maps Directions 5 (driving)", duration_ms: Date.now() - started } });
  } catch (err) {
    console.error(`[api/routes] ${err?.status ?? ""} ${err?.code ?? ""} ${err?.message ?? err}`);
    if (err instanceof NaverMapsError) {
      const status = err.code === "missing_credentials" || err.status === 401 || err.status === 403 ? 500
        : err.status === 429 ? 429 : err.code === "timeout" ? 504 : 502;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: "경로 계산 중 서버 오류가 발생했어요.", code: "server_error" });
  }
});

/**
 * GET /api/places?region=강릉&keywords=맛집,카페&sort=random
 * NAVER API HUB 지역 검색(search_places) 결과를 키워드별로 돌려줍니다.
 */
app.get("/api/places", async (req, res) => {
  const region = String(req.query.region || "").trim().slice(0, 40);
  const keywords = String(req.query.keywords || "")
    .split(",").map((k) => k.trim().slice(0, 30)).filter(Boolean).slice(0, 6);
  const sort = req.query.sort === "comment" ? "comment" : "random";
  if (!region) return res.status(400).json({ error: "검색할 여행 지역을 입력해 주세요.", code: "invalid_input" });
  if (!keywords.length) return res.status(400).json({ error: "검색 키워드를 하나 이상 골라 주세요.", code: "invalid_input" });

  const started = Date.now();
  try {
    const result = await searchPlacesMulti({ region, keywords, sort });
    res.json({ ...result, meta: { source: "NAVER API HUB /search/v1/local", sort, duration_ms: Date.now() - started } });
  } catch (err) {
    console.error(`[api/places] ${err?.status ?? ""} ${err?.code ?? ""} ${err?.message ?? err}`);
    if (err instanceof NaverApiError) {
      const status = err.code === "missing_credentials" || err.status === 401 || err.status === 403 ? 500
        : err.status === 429 ? 429 : err.code === "timeout" ? 504 : 502;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: "장소 검색 중 서버 오류가 발생했어요.", code: "server_error" });
  }
});

/**
 * POST /api/plan — AI Agent 실행
 * 응답: application/x-ndjson 스트림. 한 줄에 하나의 이벤트
 *   {type:"model_start"|"model_done"|"tool_call"|"tool_result"|"tool_skipped"|"web_search"|"limit"|"final", ...}
 *   {type:"result", plan, meta}   마지막 성공
 *   {type:"error", error, code}   실패
 * 입력 검증·설정 오류는 스트림 시작 전에 일반 JSON(4xx/5xx)으로 응답합니다.
 */
app.post("/api/plan", async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "서버에 OPENAI_API_KEY가 설정되지 않았어요. .env 파일을 확인해 주세요.", code: "missing_api_key" });
  if (!MODEL) return res.status(500).json({ error: "서버에 OPENAI_MODEL이 설정되지 않았어요. .env 파일을 확인해 주세요.", code: "missing_model" });

  const { input, errors } = validateInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(" "), code: "invalid_input" });

  res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };

  // 브라우저가 연결을 끊으면 Agent도 중단
  const ctrl = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ctrl.abort(); });

  try {
    const { plan, meta } = await runTravelAgent({
      openai, model: MODEL, userPrompt: buildUserPrompt(input), webSearch: WEB_SEARCH, signal: ctrl.signal,
      onEvent: send,
    });
    if (!Array.isArray(plan.days) || plan.days.length === 0) {
      const reason = typeof plan.region_note === "string" ? plan.region_note.trim().slice(0, 300) : "";
      send({ type: "error", error: reason || "AI가 빈 일정을 돌려줬어요. 입력을 확인하고 다시 시도해 주세요.", code: "empty_plan" });
    } else {
      // 자가용이면 출발지 왕복 유류비·통행료를 예산에 더함 (실패해도 일정은 그대로 보여줌)
      try {
        meta.round_trip = await addRoundTripCosts(plan, input);
        if (meta.round_trip) send({ type: "round_trip", origin: input.origin, region: input.region, ...meta.round_trip });
      } catch (e) {
        console.error(`[api/plan] 왕복 경로 계산 실패: ${e?.message ?? e}`);
      }
      send({ type: "result", plan, meta });
    }
  } catch (err) {
    if (ctrl.signal.aborted) return res.end();
    const body = err instanceof AgentError ? { error: err.message, code: err.code } : toClientError(err).body;
    console.error(`[api/plan] ${err?.status ?? ""} ${err?.code ?? ""} ${err?.message ?? err}`);
    send({ type: "error", ...body });
  }
  res.end();
});

/** OpenAI SDK 오류를 사용자에게 보여줄 메시지로 변환 (키나 내부 정보는 노출하지 않음) */
function toClientError(err) {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return { status: 504, body: { error: "AI 응답이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요.", code: "timeout" } };
  if (err instanceof OpenAI.APIConnectionError) return { status: 502, body: { error: "OpenAI 서버에 연결하지 못했어요. 네트워크를 확인해 주세요.", code: "connection" } };
  if (err instanceof OpenAI.AuthenticationError) return { status: 500, body: { error: "OpenAI API Key가 올바르지 않아요. 서버의 .env를 확인해 주세요.", code: "auth" } };
  if (err instanceof OpenAI.PermissionDeniedError) return { status: 500, body: { error: "이 API Key로는 해당 모델을 사용할 권한이 없어요.", code: "permission" } };
  if (err instanceof OpenAI.NotFoundError) return { status: 500, body: { error: `모델 '${MODEL}'을(를) 찾을 수 없어요. .env의 OPENAI_MODEL을 확인해 주세요.`, code: "model_not_found" } };
  if (err instanceof OpenAI.RateLimitError) {
    const quota = err.code === "insufficient_quota";
    return { status: 429, body: { error: quota ? "OpenAI 크레딧(사용 한도)이 부족해요. 결제/한도 설정을 확인해 주세요." : "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.", code: quota ? "quota" : "rate_limit" } };
  }
  if (err instanceof OpenAI.BadRequestError) return { status: 400, body: { error: "OpenAI가 요청을 처리하지 못했어요. 모델 설정(Tool·web_search 지원 여부)을 확인해 주세요.", code: "bad_request" } };
  if (err instanceof OpenAI.APIError) return { status: 502, body: { error: "OpenAI 서버에서 오류가 발생했어요. 잠시 후 다시 시도해 주세요.", code: "upstream" } };
  return { status: 500, body: { error: "서버에서 알 수 없는 오류가 발생했어요.", code: "unknown" } };
}

// 잘못된 JSON 본문 등 Express 오류 처리
app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "요청 형식이 올바르지 않아요.", code: "bad_body" });
  console.error(err);
  res.status(500).json({ error: "서버 오류가 발생했어요.", code: "server_error" });
});

app.listen(PORT, () => {
  console.log(`✈️  여행 플래너 서버: http://localhost:${PORT}`);
  console.log(`   모델: ${MODEL || "(OPENAI_MODEL 미설정)"} · API Key: ${API_KEY ? "설정됨" : "미설정"} · web_search: ${WEB_SEARCH ? "사용" : "끔"}`);
  console.log(`   NAVER 검색: ${process.env.NAVER_API_HUB_CLIENT_ID ? "설정됨" : "미설정"} · NAVER 지도: ${process.env.NAVER_MAPS_CLIENT_ID ? "설정됨" : "미설정"}`);
});
