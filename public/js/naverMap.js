/**
 * NAVER Maps Web Dynamic Map (JavaScript API v3)
 * https://navermaps.github.io/maps.js.ncp/docs/tutorial-2-Getting-Started.html
 *
 * - 스크립트: https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId={Client ID}  (구 ncpClientId → ncpKeyId)
 * - 인증 실패 시 전역 window.navermap_authFailure 호출 → 기존 SVG 지도로 대체
 * - Client ID만 사용 (Secret은 서버에만 있음). NCP 콘솔에 Web 서비스 URL(예: http://localhost:3000) 등록 필요
 */
const SDK_URL = "https://oapi.map.naver.com/openapi/v3/maps.js";

const nm = {
  status: "idle",        // idle | loading | ready | failed
  reason: "",
  map: null,
  el: null,
  overlays: [],
  markers: new Map(),    // key → { marker, color, label }
  fitSig: "",
  onFail: null,
};

export const isReady = () => nm.status === "ready";
export const failReason = () => nm.reason;

/** SDK를 불러오고 지도를 만듭니다. 성공하면 true, 키 없음·로드 실패·시간 초과면 false */
export function initNaverMap(el, keyId, { onFail } = {}) {
  nm.el = el;
  nm.onFail = onFail;
  if (!keyId) return Promise.resolve(fail("NAVER Maps Client ID가 설정되지 않았어요"));
  nm.status = "loading";

  // 인증 실패는 스크립트 로드 이후 비동기로 알려옴
  window.navermap_authFailure = () => {
    fail("NAVER Maps 인증 실패 — NCP 콘솔에서 Dynamic Map 사용 설정과 Web 서비스 URL 등록을 확인해 주세요");
    nm.onFail?.(nm.reason);
  };

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(fail("NAVER 지도 스크립트 로드 시간 초과")), 12000);

    // SDK가 window.naver.maps를 준비할 때까지 기다린 뒤 지도 생성
    // (callback 파라미터는 환경에 따라 naver 전역이 준비되기 전에 호출될 수 있어 사용하지 않음)
    const waitForSdk = () => {
      const maps = window.naver?.maps;
      if (!maps?.Map || !maps?.LatLng) return setTimeout(waitForSdk, 50);
      clearTimeout(timer);
      try {
        nm.map = new maps.Map(el, {
          center: new maps.LatLng(36.4, 127.8), zoom: 7,
          zoomControl: true, zoomControlOptions: { position: maps.Position.TOP_RIGHT },
          mapDataControl: false, scaleControl: true,
        });
        if (nm.status !== "failed") { nm.status = "ready"; document.documentElement.dataset.naverMap = "ready"; }
        finish(nm.status === "ready");
      } catch (e) {
        finish(fail(`NAVER 지도를 만들지 못했어요 (${e?.message || e})`));
      }
    };
    const s = document.createElement("script");
    s.src = `${SDK_URL}?ncpKeyId=${encodeURIComponent(keyId)}`;
    s.async = true;
    s.onload = waitForSdk;
    s.onerror = () => { clearTimeout(timer); finish(fail("NAVER 지도 스크립트를 불러오지 못했어요")); };
    document.head.appendChild(s);
  });
}

function fail(reason) {
  nm.status = "failed";
  nm.reason = reason;
  document.documentElement.dataset.naverMap = "failed";
  return false;
}

function clear() {
  nm.overlays.forEach((o) => o.setMap(null));
  nm.overlays = [];
  nm.markers.clear();
}

const iconHTML = (label, color, hl) =>
  `<div class="nmk${hl ? " hl" : ""}" style="--c:${color}"><span>${label}</span></div>`;

/**
 * 지도 그리기
 * @param {object} o
 * @param {Array<{key:string,lat:number,lng:number,label:string|number,color:string,title:string}>} o.points
 * @param {Array<{coords:Array<[number,number]>,color:string}>} o.paths  실제 도로 경로 [경도, 위도]
 * @param {string|null} o.highlight
 * @param {(key:string)=>void} o.onSelect
 */
export function drawNaverMap({ points, paths = [], highlight = null, onSelect }) {
  if (!isReady()) return;
  clear();
  const { maps } = window.naver;

  for (const p of paths) {
    if (!p.coords || p.coords.length < 2) continue;
    // 흰 테두리 + 색 선 두 겹으로 그려서 지도 위에서 잘 보이게
    const path = p.coords.map(([lng, lat]) => new maps.LatLng(lat, lng));
    nm.overlays.push(new maps.Polyline({ map: nm.map, path, strokeColor: "#ffffff", strokeWeight: 8, strokeOpacity: 0.9, strokeLineCap: "round", strokeLineJoin: "round" }));
    nm.overlays.push(new maps.Polyline({ map: nm.map, path, strokeColor: p.color, strokeWeight: 5, strokeOpacity: 0.9, strokeLineCap: "round", strokeLineJoin: "round" }));
  }

  for (const pt of points) {
    const hl = pt.key === highlight;
    const marker = new maps.Marker({
      map: nm.map,
      position: new maps.LatLng(pt.lat, pt.lng),
      title: pt.title,
      zIndex: hl ? 200 : 100,
      icon: { content: iconHTML(pt.label, pt.color, hl), anchor: new maps.Point(15, 15) },
    });
    maps.Event.addListener(marker, "click", () => onSelect?.(pt.key));
    nm.markers.set(pt.key, { marker, ...pt });
    nm.overlays.push(marker);
  }

  // 표시 대상이 바뀌었을 때만 화면 범위 조정 (강조만 바뀌면 이동만)
  const sig = points.map((p) => p.key).join("|") + "#" + paths.length;
  const all = [...points.map((p) => [p.lng, p.lat]), ...paths.flatMap((p) => p.coords || [])];
  if (sig !== nm.fitSig && all.length) {
    nm.fitSig = sig;
    if (all.length === 1) {
      nm.map.setCenter(new maps.LatLng(all[0][1], all[0][0]));
      nm.map.setZoom(14);
    } else {
      const first = new maps.LatLng(all[0][1], all[0][0]);
      const bounds = new maps.LatLngBounds(first, first);
      all.forEach(([lng, lat]) => bounds.extend(new maps.LatLng(lat, lng)));
      nm.map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
    }
  } else if (highlight && nm.markers.has(highlight)) {
    nm.map.panTo(nm.markers.get(highlight).marker.getPosition());
  }
}

/** 컨테이너 크기가 바뀌었을 때(레이아웃 변경) 지도 다시 맞추기 */
export function refreshSize() {
  if (isReady()) window.naver.maps.Event.trigger(nm.map, "resize");
}
