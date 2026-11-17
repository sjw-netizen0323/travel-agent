/**
 * get_routes — NAVER Maps Directions 5 (자동차 경로)
 * 공식 문서: https://api.ncloud-docs.com/docs/application-maps-directions5
 *
 * - GET https://maps.apigw.ntruss.com/map-direction/v1/driving
 * - 인증 헤더: x-ncp-apigw-api-key-id / x-ncp-apigw-api-key (값은 .env의 NAVER_MAPS_CLIENT_ID / SECRET)
 * - 좌표: start / goal = "경도,위도" (longitude,latitude) 순서. NAVER 지역 검색 결과(WGS84)를 그대로 사용.
 * - 응답: summary.distance(m), summary.duration(ms), tollFare(통행료), fuelPrice(유류비 추정), departureTime
 * - code 1~5(경로 없음 등)는 "확인 불가"로 돌려주고, 도보·대중교통 등 다른 수단의 경로는 만들지 않습니다.
 */

export const DIRECTIONS_URL = "https://maps.apigw.ntruss.com/map-direction/v1/driving";
export const ROUTE_OPTIONS = ["traoptimal", "trafast", "tracomfort", "traavoidtoll", "traavoidcaronly"];

/** Directions 5 응답 code → 의미 (공식 문서 표) */
export const ROUTE_CODE_MESSAGES = {
  1: "출발지와 도착지가 같아요",
  2: "출발지 또는 도착지가 도로 주변이 아니에요",
  3: "자동차 길찾기 결과를 제공할 수 없어요",
  4: "경유지가 도로 주변이 아니에요",
  5: "경유지를 포함한 직선거리 합이 1,500km 이상이에요",
};

export class NaverMapsError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "NaverMapsError";
    this.status = status;
    this.code = code;
  }
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** 한국 주변 WGS84 범위인지 확인 (위도/경도가 뒤바뀐 값도 걸러짐) */
export function isValidPoint(p) {
  return !!p && isNum(p.lat) && isNum(p.lng) && p.lat >= 32 && p.lat <= 39.5 && p.lng >= 124 && p.lng <= 132;
}
/** API 좌표 형식: "경도,위도" */
export const toLngLat = (p) => `${Number(p.lng).toFixed(7)},${Number(p.lat).toFixed(7)}`;

/** 두 지점 사이 직선거리(m, 하버사인). loc = [경도, 위도] */
function distanceM(p, loc) {
  if (!Array.isArray(loc) || !isNum(loc[0]) || !isNum(loc[1])) return 0;
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (loc[1] - p.lat) * rad, dLng = (loc[0] - p.lng) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(p.lat * rad) * Math.cos(loc[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 확인 불가 결과 (경로 없음) */
function unavailable(from, to, reason, code = null) {
  return {
    status: "unavailable",
    label: "확인 불가",
    reason,
    code,
    from: from?.name ?? null,
    to: to?.name ?? null,
    distanceM: null, durationMs: null, distanceKm: null, durationMin: null,
    tollFare: null, fuelPrice: null, arrivalTime: null, path: [],
  };
}

/**
 * get_routes (단일 구간) — 두 장소 사이 자동차 이동 거리·시간
 * @param {{name?:string,lat:number,lng:number}} from
 * @param {{name?:string,lat:number,lng:number}} to
 * @param {object} [o] { option, clientId, clientSecret, fetchImpl, timeoutMs }
 */
export async function getRoute(from, to, o = {}) {
  const clientId = o.clientId ?? process.env.NAVER_MAPS_CLIENT_ID?.trim();
  const clientSecret = o.clientSecret ?? process.env.NAVER_MAPS_CLIENT_SECRET?.trim();
  const fetchImpl = o.fetchImpl ?? fetch;
  const option = ROUTE_OPTIONS.includes(o.option) ? o.option : "traoptimal";

  if (!clientId || !clientSecret) {
    throw new NaverMapsError("NAVER Maps 인증 정보(NAVER_MAPS_CLIENT_ID / SECRET)가 .env에 없어요.", { code: "missing_credentials" });
  }
  // 좌표가 없거나 잘못되면 API를 부르지 않고 확인 불가
  if (!isValidPoint(from) || !isValidPoint(to)) {
    return unavailable(from, to, "좌표가 없거나 올바르지 않아 경로를 확인할 수 없어요", "invalid_coord");
  }

  const params = new URLSearchParams({ start: toLngLat(from), goal: toLngLat(to), option });
  let res;
  try {
    res = await fetchImpl(`${DIRECTIONS_URL}?${params}`, {
      method: "GET",
      headers: { "x-ncp-apigw-api-key-id": clientId, "x-ncp-apigw-api-key": clientSecret },
      signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new NaverMapsError("NAVER 길찾기 응답이 너무 늦어요.", { code: "timeout" });
    throw new NaverMapsError("NAVER 길찾기 서버에 연결하지 못했어요.", { code: "connection" });
  }

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 비 JSON 오류 응답 */ }

  // 길찾기 결과 코드(1~5) → 확인 불가
  // 실제 응답은 HTTP 400 + {"error":{"errorCode":400,"code":2,"message":...}} 형태 (문서 예시의 최상위 code 형태도 처리)
  const routeCode = Number.isInteger(body?.code) ? body.code : Number.isInteger(body?.error?.code) ? body.error.code : null;
  if (routeCode !== null && routeCode in ROUTE_CODE_MESSAGES) {
    return unavailable(from, to, ROUTE_CODE_MESSAGES[routeCode], routeCode);
  }
  if (!res.ok) {
    const code = body?.error?.errorCode || body?.errorCode || `http_${res.status}`;
    const msg = res.status === 401 || res.status === 403
      ? "NAVER Maps 인증에 실패했어요. Client ID/Secret과 Directions 5 사용 설정을 확인해 주세요."
      : res.status === 429 ? "NAVER 길찾기 호출 한도를 초과했어요(또는 Directions 5가 앱에 선택되지 않았어요)."
      : `NAVER 길찾기 요청이 실패했어요. (${code})`;
    throw new NaverMapsError(msg, { status: res.status, code });
  }

  const routeObj = body?.route?.[option]?.[0];
  const summary = routeObj?.summary;
  if (!summary || !isNum(summary.distance) || !isNum(summary.duration)) {
    return unavailable(from, to, "자동차 경로 정보가 응답에 없어요", "no_route");
  }
  // API는 요청 좌표를 가까운 도로로 보정함 → 보정 거리가 크면 안내 (경로 자체는 API 결과 그대로)
  const snapM = Math.round(Math.max(
    distanceM(from, summary.start?.location),
    distanceM(to, summary.goal?.location),
  ));
  return {
    status: "ok",
    label: "자동차",
    reason: null,
    snapM,
    note: snapM > 500 ? `요청 위치에서 약 ${(snapM / 1000).toFixed(1)}km 떨어진 도로 기준 경로예요` : null,
    code: 0,
    from: from.name ?? null,
    to: to.name ?? null,
    distanceM: summary.distance,
    durationMs: summary.duration,
    distanceKm: Math.round(summary.distance / 100) / 10,
    durationMin: Math.max(1, Math.round(summary.duration / 60000)),
    tollFare: isNum(summary.tollFare) ? summary.tollFare : null,
    fuelPrice: isNum(summary.fuelPrice) ? summary.fuelPrice : null,
    arrivalTime: summary.departureTime ?? null, // 문서상 "도착 예정 시각"
    option,
    path: simplifyPath(routeObj.path), // 지도에 그릴 실제 도로 경로 [[경도, 위도], ...]
  };
}

/** 경로 좌표가 너무 많으면 균등하게 줄임 (처음·끝 유지) */
export function simplifyPath(path, max = 250) {
  if (!Array.isArray(path)) return [];
  const pts = path.filter((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]));
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => pts[Math.round(i * step)]);
}

/**
 * get_routes (여러 구간) — 장소 목록의 연속 구간(A→B, B→C, …)을 계산
 * 인증 오류처럼 모든 구간에 해당하는 오류는 throw, 구간별 경로 없음은 "확인 불가"로 담음
 * @param {Array<{name?:string,lat:number,lng:number}>} stops
 * @param {object} [o] getRoute 옵션 + { concurrency }
 */
export async function getRoutes(stops, o = {}) {
  const legs = [];
  for (let i = 0; i < stops.length - 1; i++) legs.push([stops[i], stops[i + 1]]);
  return getRoutesForLegs(legs.map(([from, to]) => ({ from, to })), o);
}

/** 임의의 구간 목록 계산 (순서 유지, 동시 호출 수 제한) */
export async function getRoutesForLegs(legs, o = {}) {
  const concurrency = Math.max(1, Math.min(5, o.concurrency ?? 3));
  const results = new Array(legs.length);
  let next = 0;
  async function worker() {
    while (next < legs.length) {
      const i = next++;
      results[i] = await getRoute(legs[i].from, legs[i].to, o);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, legs.length) }, worker));

  const ok = results.filter((r) => r.status === "ok");
  const sum = (k) => ok.reduce((a, r) => a + (r[k] ?? 0), 0);
  return {
    legs: results,
    totals: {
      legs: results.length,
      ok: ok.length,
      unavailable: results.length - ok.length,
      distanceKm: Math.round(sum("distanceM") / 100) / 10,
      durationMin: Math.round(sum("durationMs") / 60000),
      tollFare: sum("tollFare"),
      fuelPrice: sum("fuelPrice"),
    },
  };
}
