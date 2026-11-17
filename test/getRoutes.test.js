// 오프라인 단위 테스트 (실제 API 호출 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { getRoute, getRoutes, toLngLat, DIRECTIONS_URL, NaverMapsError } from "../lib/getRoutes.js";

const creds = { clientId: "id", clientSecret: "secret" };
const A = { name: "오죽헌", lat: 37.7792, lng: 128.8775 };
const B = { name: "경포호", lat: 37.7979, lng: 128.9049 };
const json = (status, body) => new Response(JSON.stringify(body), { status });
const okBody = (distance, duration, extra = {}) => ({
  code: 0, message: "길찾기를 성공하였습니다.",
  route: { traoptimal: [{ summary: { distance, duration, tollFare: 0, fuelPrice: 500, departureTime: "2026-11-17T21:00:00", ...extra } }] },
});

test("좌표는 '경도,위도' 순서로 보냄 + 인증 헤더", async () => {
  let req;
  const fetchImpl = async (url, init) => { req = { url: new URL(url), init }; return json(200, okBody(4200, 540000)); };
  await getRoute(A, B, { ...creds, fetchImpl });
  assert.equal(req.url.origin + req.url.pathname, DIRECTIONS_URL);
  assert.equal(req.url.searchParams.get("start"), "128.8775000,37.7792000");
  assert.equal(req.url.searchParams.get("goal"), "128.9049000,37.7979000");
  assert.equal(req.url.searchParams.get("option"), "traoptimal");
  assert.equal(req.init.headers["x-ncp-apigw-api-key-id"], "id");
  assert.equal(req.init.headers["x-ncp-apigw-api-key"], "secret");
  assert.equal(toLngLat({ lat: 1, lng: 2 }), "2.0000000,1.0000000");
});

test("거리(m)·시간(ms)을 km·분으로 변환", async () => {
  const r = await getRoute(A, B, { ...creds, fetchImpl: async () => json(200, okBody(4250, 545000, { tollFare: 1200 })) });
  assert.equal(r.status, "ok");
  assert.equal(r.distanceKm, 4.3);
  assert.equal(r.durationMin, 9);
  assert.equal(r.tollFare, 1200);
  assert.equal(r.fuelPrice, 500);
});

test("경로 없음(code 1~5)은 '확인 불가', 다른 이동수단을 만들지 않음", async () => {
  // 실제 API 형식(error.code)과 문서 예시 형식(최상위 code) 모두
  const shapes = [(code) => ({ error: { errorCode: 400, code, message: "x" } }), (code) => ({ code, message: "x" })];
  for (const [code, shape] of [1, 2, 3, 4, 5].flatMap((c) => shapes.map((s) => [c, s]))) {
    const r = await getRoute(A, B, { ...creds, fetchImpl: async () => json(400, shape(code)) });
    assert.equal(r.status, "unavailable");
    assert.equal(r.label, "확인 불가");
    assert.equal(r.code, code);
    assert.equal(r.distanceKm, null);
    assert.equal(r.durationMin, null);
    for (const k of ["walk", "walking", "transit", "publicTransport"]) assert.ok(!(k in r));
  }
});

test("좌표가 없거나 범위 밖이면 API를 부르지 않고 '확인 불가'", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  const r1 = await getRoute({ name: "x", lat: null, lng: null }, B, { ...creds, fetchImpl });
  const r2 = await getRoute({ name: "뒤바뀐 좌표", lat: 128.8, lng: 37.7 }, B, { ...creds, fetchImpl });
  assert.equal(r1.status, "unavailable");
  assert.equal(r2.status, "unavailable");
  assert.equal(called, false);
});

test("인증 실패·인증 정보 없음은 오류로 던짐", async () => {
  await assert.rejects(getRoute(A, B, { ...creds, fetchImpl: async () => json(401, { error: { errorCode: "200", message: "Authentication Failed" } }) }),
    (e) => e instanceof NaverMapsError && e.status === 401);
  await assert.rejects(getRoute(A, B, { clientId: "", clientSecret: "", fetchImpl: async () => {} }),
    (e) => e.code === "missing_credentials");
});

test("getRoutes: 연속 구간 계산, 확인 불가 구간은 합계에서 제외", async () => {
  const C = { name: "C", lat: 37.75, lng: 128.9 };
  const fetchImpl = async (url) => {
    const goal = new URL(url).searchParams.get("goal");
    return goal.startsWith("128.9000000") ? json(400, { code: 3, message: "no" }) : json(200, okBody(10000, 600000, { tollFare: 800 }));
  };
  const r = await getRoutes([A, B, C], { ...creds, fetchImpl });
  assert.equal(r.legs.length, 2);
  assert.deepEqual(r.legs.map((l) => l.status), ["ok", "unavailable"]);
  assert.equal(r.totals.ok, 1);
  assert.equal(r.totals.unavailable, 1);
  assert.equal(r.totals.distanceKm, 10);
  assert.equal(r.totals.durationMin, 10);
  assert.equal(r.totals.tollFare, 800);
});
