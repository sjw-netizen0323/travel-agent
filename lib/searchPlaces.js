/**
 * search_places — NAVER API HUB 지역 검색 (/search/v1/local)
 * 공식 문서: https://api.ncloud-docs.com/docs/naver-api-hub-search-local
 *
 * - 인증: X-NCP-APIGW-API-KEY-ID / X-NCP-APIGW-API-KEY 헤더 (값은 .env에서 읽음)
 * - display: 1~5 (한 번에 최대 5건), sort: random(정확도순) | comment(리뷰 많은 순)
 * - mapx = 경도, mapy = 위도 (WGS84). 문서에 스케일 표기가 없어
 *   정수형(도 × 10^7, 예: "1289012345")과 소수형(예: "128.9012345")을 모두 처리합니다.
 * - API가 주는 필드(이름·주소·카테고리·좌표·링크·설명)만 사용하고, 영업시간·평점·가격 등은 만들지 않습니다.
 */

export const NAVER_LOCAL_URL = "https://naverapihub.apigw.ntruss.com/search/v1/local";
export const MAX_DISPLAY = 5;

export class NaverApiError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "NaverApiError";
    this.status = status;
    this.code = code;
  }
}

/** <b>강릉</b> 같은 하이라이트 태그와 HTML 엔티티 제거 */
export function stripHtml(s = "") {
  return String(s)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .trim();
}

/**
 * mapx/mapy 문자열 → 십진수 도(degree). 잘못된 값이면 null.
 * - |값| > 1000 이면 도 × 10^7 정수로 보고 10^7로 나눔 (경도 124~132, 위도 33~39 범위라 1000을 넘을 수 없음)
 */
export function parseCoord(raw, kind) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  let v = Number(raw);
  if (!Number.isFinite(v)) return null;
  if (Math.abs(v) > 1000) v = v / 1e7;
  const ok = kind === "lng" ? v >= 120 && v <= 135 : v >= 30 && v <= 45; // 한반도 주변 범위 검증
  return ok ? Math.round(v * 1e7) / 1e7 : null;
}

/** API item → 앱에서 쓰는 장소 객체 (API에 있는 정보만) */
export function normalizeItem(item) {
  const lat = parseCoord(item.mapy, "lat");
  const lng = parseCoord(item.mapx, "lng");
  const category = stripHtml(item.category);
  return {
    name: stripHtml(item.title),
    category,
    categoryPath: category ? category.split(">").map((c) => c.trim()).filter(Boolean) : [],
    address: stripHtml(item.address),
    roadAddress: stripHtml(item.roadAddress),
    lat,
    lng,
    hasCoord: lat !== null && lng !== null,
    link: typeof item.link === "string" && /^https?:\/\//.test(item.link) ? item.link : "",
    description: stripHtml(item.description),
  };
}

/**
 * search_places — 지역 + 키워드로 장소 검색
 * @param {object} p
 * @param {string} p.region   여행 지역 (예: "강릉")
 * @param {string} p.keyword  키워드 (예: "맛집", "카페", "관광지")
 * @param {number} [p.display=5]  1~5
 * @param {"random"|"comment"} [p.sort="random"]
 * @param {object} [opts] { clientId, clientSecret, fetchImpl, timeoutMs }
 * @returns {Promise<{query:string,total:number,places:object[]}>}
 */
export async function searchPlaces({ region, keyword, display = MAX_DISPLAY, sort = "random" }, opts = {}) {
  const clientId = opts.clientId ?? process.env.NAVER_API_HUB_CLIENT_ID?.trim();
  const clientSecret = opts.clientSecret ?? process.env.NAVER_API_HUB_CLIENT_SECRET?.trim();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;

  if (!clientId || !clientSecret) {
    throw new NaverApiError("NAVER API HUB 인증 정보(NAVER_API_HUB_CLIENT_ID / SECRET)가 .env에 없어요.", { code: "missing_credentials" });
  }
  const query = [region, keyword].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  if (!query) throw new NaverApiError("검색할 지역이나 키워드를 입력해 주세요.", { code: "empty_query" });

  const params = new URLSearchParams({
    query,
    display: String(Math.min(MAX_DISPLAY, Math.max(1, Number(display) || MAX_DISPLAY))),
    start: "1",
    sort: sort === "comment" ? "comment" : "random",
    format: "json",
  });

  let res;
  try {
    res = await fetchImpl(`${NAVER_LOCAL_URL}?${params}`, {
      method: "GET",
      headers: { "X-NCP-APIGW-API-KEY-ID": clientId, "X-NCP-APIGW-API-KEY": clientSecret },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new NaverApiError("NAVER 검색 응답이 너무 늦어요.", { code: "timeout" });
    throw new NaverApiError("NAVER 검색 서버에 연결하지 못했어요.", { code: "connection" });
  }

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 오류 응답이 JSON이 아닐 수 있음 */ }

  if (!res.ok) {
    // 검색 API 오류: { errorCode: "SE01", errorMessage } / API Gateway 오류: { error: { errorCode, message } }
    const code = body?.errorCode || body?.error?.errorCode || `http_${res.status}`;
    const msg = res.status === 401 || res.status === 403
      ? "NAVER API HUB 인증에 실패했어요. Client ID/Secret과 지역 검색 API 사용 신청 여부를 확인해 주세요."
      : res.status === 429 ? "NAVER 검색 호출 한도를 초과했어요. 잠시 후 다시 시도해 주세요."
      : `NAVER 검색 요청이 실패했어요. (${code})`;
    throw new NaverApiError(msg, { status: res.status, code });
  }
  if (!body || !Array.isArray(body.items)) {
    throw new NaverApiError("NAVER 검색 응답 형식이 예상과 달라요.", { status: res.status, code: "bad_response" });
  }

  return { query, total: Number(body.total) || 0, places: body.items.map(normalizeItem) };
}

/**
 * 여러 키워드를 한 번에 검색해 합치기 (이름+주소 기준 중복 제거)
 * 일부 키워드가 실패해도 나머지 결과는 돌려주고, 실패 내역은 errors에 담습니다.
 */
export async function searchPlacesMulti({ region, keywords, display = MAX_DISPLAY, sort = "random" }, opts = {}) {
  const list = [...new Set((keywords || []).map((k) => k.trim()).filter(Boolean))].slice(0, 6);
  const settled = await Promise.allSettled(list.map((keyword) => searchPlaces({ region, keyword, display, sort }, opts)));
  const seen = new Set();
  const groups = [], errors = [];
  settled.forEach((r, i) => {
    if (r.status === "rejected") return errors.push({ keyword: list[i], message: r.reason?.message, code: r.reason?.code });
    const places = r.value.places.filter((p) => {
      const key = `${p.name}|${p.roadAddress || p.address}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    groups.push({ keyword: list[i], query: r.value.query, total: r.value.total, places });
  });
  if (!groups.length && errors.length) {
    const first = settled.find((r) => r.status === "rejected").reason;
    throw first;
  }
  return { region, groups, errors };
}
