// 오프라인 단위 테스트 (실제 API 호출 없음): node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchPlaces, searchPlacesMulti, parseCoord, stripHtml, normalizeItem, NAVER_LOCAL_URL, NaverApiError } from "../lib/searchPlaces.js";

const creds = { clientId: "test-id", clientSecret: "test-secret" };
const okResponse = (items, total = items.length) =>
  new Response(JSON.stringify({ lastBuildDate: "x", total, start: 1, display: items.length, items }), { status: 200 });

const sampleItem = {
  title: "<b>강릉</b> 초당순두부 &amp; 카페",
  link: "https://example.com/place",
  category: "한식>두부요리",
  description: "",
  telephone: "",
  address: "강원특별자치도 강릉시 초당동 1",
  roadAddress: "강원특별자치도 강릉시 초당순두부길 1",
  mapx: "1289150000",
  mapy: "377905000",
};

test("parseCoord: 도×10^7 정수와 소수 모두 처리", () => {
  assert.equal(parseCoord("1289150000", "lng"), 128.915);
  assert.equal(parseCoord("377905000", "lat"), 37.7905);
  assert.equal(parseCoord("128.915", "lng"), 128.915);
  assert.equal(parseCoord("37.7905", "lat"), 37.7905);
});

test("parseCoord: 빈 값/범위 밖/숫자 아님은 null", () => {
  assert.equal(parseCoord("", "lat"), null);
  assert.equal(parseCoord(undefined, "lat"), null);
  assert.equal(parseCoord("abc", "lng"), null);
  assert.equal(parseCoord("0", "lat"), null);
  assert.equal(parseCoord("37.5", "lng"), null); // 위도 값을 경도로 잘못 넣은 경우
  assert.equal(parseCoord("314123", "lng"), null); // 구 KATEC 형식 값
});

test("stripHtml: 하이라이트 태그와 엔티티 제거", () => {
  assert.equal(stripHtml("<b>강릉</b> 커피 &amp; 빵"), "강릉 커피 & 빵");
});

test("normalizeItem: API 필드만 추출, 추가 정보 생성 안 함", () => {
  const p = normalizeItem(sampleItem);
  assert.deepEqual(p, {
    name: "강릉 초당순두부 & 카페",
    category: "한식>두부요리",
    categoryPath: ["한식", "두부요리"],
    address: "강원특별자치도 강릉시 초당동 1",
    roadAddress: "강원특별자치도 강릉시 초당순두부길 1",
    lat: 37.7905,
    lng: 128.915,
    hasCoord: true,
    link: "https://example.com/place",
    description: "",
  });
  for (const k of ["rating", "openingHours", "price", "telephone"]) assert.ok(!(k in p), `${k} 필드가 있으면 안 됨`);
});

test("searchPlaces: 올바른 URL·헤더·파라미터로 호출", async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = { url: new URL(url), init }; return okResponse([sampleItem], 42); };
  const r = await searchPlaces({ region: "강릉", keyword: "맛집", display: 99, sort: "comment" }, { ...creds, fetchImpl });

  assert.equal(captured.url.origin + captured.url.pathname, NAVER_LOCAL_URL);
  assert.equal(captured.url.searchParams.get("query"), "강릉 맛집");
  assert.equal(captured.url.searchParams.get("display"), "5"); // 최대 5로 제한
  assert.equal(captured.url.searchParams.get("sort"), "comment");
  assert.equal(captured.init.headers["X-NCP-APIGW-API-KEY-ID"], "test-id");
  assert.equal(captured.init.headers["X-NCP-APIGW-API-KEY"], "test-secret");
  assert.equal(r.total, 42);
  assert.equal(r.places[0].name, "강릉 초당순두부 & 카페");
});

test("searchPlaces: 인증 정보 없으면 호출 전에 오류", async () => {
  let called = false;
  await assert.rejects(
    searchPlaces({ region: "강릉", keyword: "카페" }, { clientId: "", clientSecret: "", fetchImpl: async () => { called = true; } }),
    (e) => e instanceof NaverApiError && e.code === "missing_credentials",
  );
  assert.equal(called, false);
});

test("searchPlaces: 401 / SE 오류 코드 처리", async () => {
  await assert.rejects(
    searchPlaces({ region: "강릉", keyword: "카페" }, { ...creds, fetchImpl: async () => new Response(JSON.stringify({ error: { errorCode: "200", message: "Authentication Failed" } }), { status: 401 }) }),
    (e) => e.status === 401 && /인증/.test(e.message),
  );
  await assert.rejects(
    searchPlaces({ region: "강릉", keyword: "카페" }, { ...creds, fetchImpl: async () => new Response(JSON.stringify({ errorCode: "SE02", errorMessage: "Invalid display value" }), { status: 400 }) }),
    (e) => e.code === "SE02",
  );
});

test("searchPlacesMulti: 키워드별 그룹 + 중복 제거 + 부분 실패 허용", async () => {
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams.get("query");
    if (q.endsWith("실패")) return new Response("{}", { status: 500 });
    return okResponse([sampleItem, { ...sampleItem, title: q + " 장소", roadAddress: q }]);
  };
  const r = await searchPlacesMulti({ region: "강릉", keywords: ["맛집", "카페", "실패", "맛집"] }, { ...creds, fetchImpl });
  assert.equal(r.groups.length, 2);
  assert.equal(r.groups[0].places.length, 2);
  assert.equal(r.groups[1].places.length, 1); // sampleItem 중복 제거
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].keyword, "실패");
});
