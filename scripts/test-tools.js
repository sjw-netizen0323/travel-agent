// get_routes(실제 NAVER Directions 5 호출) + calculate_budget 실행 테스트
// 실행: npm run test:tools
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { getRoute, getRoutes } from "../lib/getRoutes.js";
import { calculateBudget } from "../public/js/calculateBudget.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const won = (n) => (n === null ? "-" : n.toLocaleString("ko-KR") + "원");
let failed = 0;
const check = (label, ok) => { console.log(`   ${ok ? "✅" : "❌"} ${label}`); if (!ok) failed++; };

// 좌표: 앞 단계에서 NAVER 지역 검색으로 얻은 WGS84 값
const 오죽헌 = { name: "오죽헌", lat: 37.77922, lng: 128.87753 };
const 경포호 = { name: "경포호", lat: 37.797933, lng: 128.9048623 };
const 안목 = { name: "에이엠브레드앤커피(안목)", lat: 37.7724092, lng: 128.9475239 };
const 하슬라 = { name: "하슬라아트월드", lat: 37.7054563, lng: 129.0078447 };
const 서울시청 = { name: "서울시청", lat: 37.5665, lng: 126.978 };
const 동해바다 = { name: "동해 바다 한가운데(도로 없음)", lat: 37.6, lng: 130.0 };
const 같은지점 = { name: "경포호(같은 지점)", lat: 37.797933, lng: 128.9048623 };

console.log("━━━━━━━━ 1. get_routes (NAVER Maps Directions 5) ━━━━━━━━\n");

try {
  console.log("■ 단일 구간: 오죽헌 → 경포호");
  const r = await getRoute(오죽헌, 경포호);
  console.log(`   ${r.status} · ${r.distanceKm}km · ${r.durationMin}분 · 통행료 ${won(r.tollFare)} · 유류비 ${won(r.fuelPrice)}`);
  check("자동차 경로 찾음", r.status === "ok");
  check("거리 0~20km 사이 (시내 이동)", r.distanceKm > 0 && r.distanceKm < 20);
  check("시간 1~60분 사이", r.durationMin >= 1 && r.durationMin <= 60);

  console.log("\n■ 장거리: 서울시청 → 오죽헌");
  const far = await getRoute(서울시청, 오죽헌);
  console.log(`   ${far.status} · ${far.distanceKm}km · ${far.durationMin}분 · 통행료 ${won(far.tollFare)} · 유류비 ${won(far.fuelPrice)}`);
  check("200~300km 사이", far.distanceKm > 200 && far.distanceKm < 300);
  check("고속도로 통행료 > 0", far.tollFare > 0);

  console.log("\n■ 경로 없음: 경포호 → 동해 바다 한가운데");
  const none = await getRoute(경포호, 동해바다);
  console.log(`   ${none.status} · ${none.label} · 사유: ${none.reason} (code ${none.code})`);
  check("'확인 불가'로 표시", none.status === "unavailable" && none.label === "확인 불가");
  check("거리·시간을 만들어내지 않음", none.distanceKm === null && none.durationMin === null);

  console.log("\n■ 경로 없음: 출발지 = 도착지");
  const same = await getRoute(경포호, 같은지점);
  console.log(`   ${same.status} · ${same.label} · 사유: ${same.reason} (code ${same.code})`);
  check("'확인 불가'로 표시", same.status === "unavailable" && same.code === 1);

  console.log("\n■ 좌표 없음: (좌표 없는 장소) → 경포호");
  const noCoord = await getRoute({ name: "좌표 없는 장소", lat: null, lng: null }, 경포호);
  console.log(`   ${noCoord.status} · ${noCoord.reason}`);
  check("'확인 불가'로 표시", noCoord.status === "unavailable");

  console.log("\n■ 여러 구간: 오죽헌 → 경포호 → 안목 → 하슬라아트월드");
  const multi = await getRoutes([오죽헌, 경포호, 안목, 하슬라]);
  multi.legs.forEach((l) => console.log(`   ${l.from} → ${l.to}: ${l.status === "ok" ? `${l.distanceKm}km · ${l.durationMin}분` : `확인 불가 (${l.reason})`}`));
  console.log(`   합계: ${multi.totals.distanceKm}km · ${multi.totals.durationMin}분 · 통행료 ${won(multi.totals.tollFare)} · 유류비 ${won(multi.totals.fuelPrice)}`);
  check("3구간 모두 계산", multi.totals.ok === 3);
  var routeTotals = multi.totals;
} catch (err) {
  failed++;
  console.log(`   ❌ ${err.message} (status=${err.status ?? "-"}, code=${err.code ?? "-"})`);
}

console.log("\n━━━━━━━━ 2. calculate_budget ━━━━━━━━\n");
const budget = calculateBudget({
  totalBudget: 800000,
  people: 2,
  required: ["transport", "lodging", "food", "sightseeing"],
  items: [
    { category: "transport", label: "현지 이동 통행료 (NAVER 경로)", amount: routeTotals?.tollFare ?? null, status: "confirmed", source: "NAVER Directions 5" },
    { category: "transport", label: "현지 이동 유류비 (NAVER 추정)", amount: routeTotals?.fuelPrice ?? null, status: "estimated", source: "NAVER Directions 5 fuelPrice" },
    { category: "transport", label: "서울 ↔ 강릉 왕복 유류비·통행료", amount: 110000, status: "estimated", source: "AI 추정" },
    { category: "lodging", label: "숙박 (2박 · 객실 1개)", amount: 140000, quantity: 2, status: "estimated", source: "AI 추정" },
    { category: "food", label: "식비 (1인 6끼)", amount: 15000, unit: "perPerson", quantity: 6, status: "estimated", source: "AI 추정" },
    { category: "sightseeing", label: "오죽헌 입장료", amount: 3000, unit: "perPerson", status: "confirmed", source: "테스트 입력값" },
    { category: "sightseeing", label: "하슬라아트월드 입장료", amount: null, source: "가격 정보 없음" },
    { category: "shopping", label: "카페·기념품", amount: 60000, source: "AI 추정" },
  ],
});
for (const c of budget.categories) {
  console.log(`■ ${c.icon} ${c.label}: ${won(c.total)} (확인됨 ${won(c.confirmed)} · 추정치 ${won(c.estimated)}${c.unknownCount ? ` · 미확인 ${c.unknownCount}건` : ""})`);
  c.items.forEach((it) => console.log(`     - [${it.statusLabel}] ${it.label}: ${won(it.total)}${it.source ? ` (${it.source})` : ""}`));
}
console.log(`\n   총예산 ${won(budget.totalBudget)} · 합계 ${won(budget.totals.known)} (확인됨 ${won(budget.totals.confirmed)} + 추정치 ${won(budget.totals.estimated)})`);
console.log(`   잔여 예산 ${won(budget.remaining)} · 1인당 ${won(budget.perPerson)} · 상태: ${budget.statusLabel}`);
budget.warnings.forEach((w) => console.log(`   ⚠️ ${w}`));

check("합계 = 확인됨 + 추정치", budget.totals.known === budget.totals.confirmed + budget.totals.estimated);
check("잔여 = 총예산 − 합계", budget.remaining === 800000 - budget.totals.known);
check("가격 없는 항목은 미확인으로 분리", budget.items.some((i) => i.status === "unknown" && i.total === null));

console.log(failed ? `\n❌ 실패 ${failed}건` : "\n✅ 모든 검사 통과");
process.exit(failed ? 1 : 0);
