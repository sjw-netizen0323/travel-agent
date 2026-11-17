// 실제 OpenAI + NAVER로 Agent Loop 실행 (토큰 비용 발생): npm run test:agent -- [지역] [추가 요청]
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import OpenAI from "openai";
import { runTravelAgent } from "../lib/agent.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const [region = "강릉", notes = "오죽헌은 꼭 가고 싶어요. 장소 사이 이동 시간을 알려주세요."] = process.argv.slice(2);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim(), timeout: 90_000, maxRetries: 2 });
const prompt = `다음 조건으로 국내 자동차 여행 일정을 만들어 주세요. 필요한 Tool을 골라 사용하세요.\n${JSON.stringify({
  region, start_date: "2026-12-04", days: 2, trip_length: "1박 2일", people: 2, total_budget_krw: 600000,
  preferences: ["맛집", "역사"], transport: "자가용(출발지에서 직접 운전)", origin: "서울", extra_request: notes,
}, null, 2)}`;

const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + "s";
const { plan, meta } = await runTravelAgent({
  openai, model: process.env.OPENAI_MODEL.trim(), userPrompt: prompt,
  onEvent: (e) => {
    if (e.type === "model_start") console.log(`${sec()} 🧠 LLM 호출 #${e.turn}${e.forceFinal ? " (최종 답변 강제)" : ""}`);
    if (e.type === "model_done") console.log(`${sec()}    → ${e.functionCalls.length ? `Tool 선택: ${e.functionCalls.join(", ")}` : e.webSearches ? "" : "최종 답변"}${e.webSearches ? ` web_search ${e.webSearches}회` : ""}`);
    if (e.type === "web_search") console.log(`${sec()} 🌐 web_search ${e.action}: ${e.queries.join(" | ") || e.url || ""}`);
    if (e.type === "tool_call") console.log(`${sec()} 🔧 ${e.name}(${JSON.stringify(e.args).slice(0, 110)})`);
    if (e.type === "tool_result") console.log(`${sec()}    ${e.ok ? "✅" : "❌"} ${e.name}: ${e.summary} (${e.ms}ms)`);
    if (e.type === "limit") console.log(`${sec()} ⛔ 한도 도달: ${e.reason}`);
    if (e.type === "final") console.log(`${sec()} 🔍 검증: 근거 없는 값 ${e.verification.total}개 제거 ${JSON.stringify(e.verification.fixes)}`);
  },
});

console.log(`\n${plan.emoji} ${plan.title} — ${meta.turns}턴, Tool ${meta.tool_calls.length}회, web_search ${meta.web_searches}회, 토큰 ${meta.usage.total_tokens}`);
for (const [i, d] of plan.days.entries()) {
  console.log(`DAY ${i + 1} ${d.title}`);
  for (const s of d.stops) {
    const drive = s.drive_min !== null ? `🚗${s.drive_km}km/${s.drive_min}분` : "🚗미확인";
    const cost = s.cost !== null ? `${s.cost}원(${s.cost_source})` : "가격 미확인";
    console.log(`  ${s.time} ${s.name} [${s.place_source}${s.lat !== null ? ` ${s.lat.toFixed(4)},${s.lng.toFixed(4)}` : ""}] ${drive} · ${cost}`);
  }
}
console.log("예산:", plan.budget_items.map((b) => `${b.label}=${b.amount ?? "미확인"}(${b.status})`).join(", "));
console.log("참고:", plan.references);
