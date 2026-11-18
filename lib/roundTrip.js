/**
 * 출발지 ↔ 여행지 왕복 유류비·통행료 (자가용일 때)
 * - Agent의 get_routes는 여행지 안의 이동만 계산하므로, 서울→강릉 같은 왕복 구간은 서버에서 직접 계산해 예산에 더합니다.
 * - 출발지 좌표: NAVER 지역 검색 결과 여러 곳의 중심 (도시 이름 검색은 그 도시의 아무 매장이나 나오므로 평균으로 근사)
 * - 왕복 구간: 출발지 → 1일차 첫 장소, 마지막 날 마지막 장소 → 출발지 (NAVER Directions 5)
 */
import { searchPlaces as defaultSearch } from "./searchPlaces.js";
import { getRoutesForLegs as defaultRoutes } from "./getRoutes.js";

const hasCoord = (s) => s && typeof s.lat === "number" && typeof s.lng === "number";

/** 출발지 이름 → 근사 좌표 후보 (중심 좌표, 실패 시 첫 검색 결과) */
async function locateOrigin(origin, search) {
  const r = await search({ keyword: origin, display: 5, sort: "comment" });
  const pts = (r.places || []).filter(hasCoord);
  if (!pts.length) return [];
  const center = { name: origin, lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length };
  return [center, { name: origin, lat: pts[0].lat, lng: pts[0].lng }];
}

/**
 * plan.budget_items에 왕복 유류비·통행료를 더하고, 계산 내역을 돌려줍니다. (계산할 수 없으면 null)
 * @param {object} plan  Agent 최종 일정 (제자리 수정)
 * @param {{origin:string, region:string, transport:string, toll:boolean}} input
 */
export async function addRoundTripCosts(plan, input, { search = defaultSearch, routes = defaultRoutes } = {}) {
  if (input.transport !== "own" || !input.origin) return null;
  const days = plan.days || [];
  const first = days[0]?.stops?.find(hasCoord);
  const last = [...(days.at(-1)?.stops || [])].reverse().find(hasCoord);
  if (!first || !last) return null;

  for (const from of await locateOrigin(input.origin, search)) {
    const r = await routes([{ from, to: first }, { from: last, to: from }]);
    if (r.totals.ok !== 2) continue; // 중심 좌표가 도로에서 멀면 첫 검색 결과로 다시 시도

    const { distanceKm, durationMin, fuelPrice, tollFare } = r.totals;
    const trip = `${input.origin} ↔ ${input.region}`;
    const items = plan.budget_items || (plan.budget_items = []);
    // Agent가 넣은 유류비·통행료는 현지 이동분임을 표시
    for (const it of items) if ((it.key === "fuel" || it.key === "toll") && !it.label.startsWith("현지")) it.label = `현지 이동 ${it.label}`;
    items.push({ key: "fuel", label: `왕복 유류비 (${trip}, ${Math.round(distanceKm)}km)`, amount: fuelPrice, status: "estimated", source: "get_routes (출발지 왕복)" });
    if (input.toll) items.push({ key: "toll", label: `왕복 통행료 (${trip})`, amount: tollFare, status: "confirmed", source: "get_routes (출발지 왕복)" });
    return { distanceKm, durationMin, fuelPrice, tollFare: input.toll ? tollFare : null };
  }
  return null;
}
