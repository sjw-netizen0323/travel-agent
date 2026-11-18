/* 여행 플래너 — 프론트엔드
 * - 처음 열면 샘플 데이터로 미리보기를 보여줍니다.
 * - "여행 일정 만들기"를 누르면 서버의 POST /api/plan → OpenAI Responses API로 실제 일정을 생성합니다.
 * - API Key는 서버에만 있고, 브라우저는 /api/plan · /api/places · /api/routes만 호출합니다.
 * - 예산은 calculate_budget(외부 API 없는 순수 함수)로 계산합니다.
 */
import { calculateBudget, BUDGET_CATEGORIES } from "./calculateBudget.js";
import { initNaverMap, drawNaverMap, isReady as isNaverReady, failReason as naverFailReason } from "./naverMap.js";

(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const won = (n) => Math.round(n).toLocaleString("ko-KR") + "원";
  const manwon = (n) => {
    const m = n / 10000;
    return (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10).toLocaleString("ko-KR") + "만원";
  };
  const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tripLength = (n) => (n === 1 ? "당일치기" : `${n - 1}박 ${n}일`);
  const TRANSPORT_LABEL = { own: "자가용", rental: "렌터카", "ktx-rental": "KTX+렌터카" };
  const BUDGET_ICON = { flight: "✈️", ktx: "🚄", rental: "🔑", fuel: "⛽", toll: "🛣️", lodging: "🏨", food: "🍜", sight: "🎟️", cafe: "☕", etc: "🧾", reserve: "🧷" };
  const CLIENT_TIMEOUT_MS = 200_000; // 서버 Agent 제한(150초) + 최종 답변 여유

  const state = {
    plan: null, activeDay: "all", highlight: null, running: false,
    places: null,          // NAVER 검색 결과 { region, groups, errors, meta }
    mapMode: "plan",       // "plan" | "places"
    placeHL: null,         // 강조된 검색 결과 번호
    searching: false,
    routes: null,          // get_routes 결과: 날짜 index별 { legs, totals }
    routesSummary: null,   // 전체 합계
    routing: false,
  };

  /* ───────────── 폼 초기화 & 인터랙션 ───────────── */
  const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (d) => `${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]})`;
  function defaultStartDate() {
    const d = new Date();
    d.setDate(d.getDate() + 10);
    while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
    return toISO(d);
  }

  function setPeople(n) {
    n = Math.min(12, Math.max(1, n));
    $("#people").value = n;
    $("#peopleOut").textContent = n + "명";
  }
  function setBudget(n) { $("#budget").value = n ? Number(n).toLocaleString("ko-KR") : ""; }
  const getBudget = () => Number(String($("#budget").value).replace(/[^\d]/g, "")) || 0;

  function updateDateHint() {
    const s = $("#startDate").value;
    const n = Number($("#duration").value);
    if (!s) return ($("#dateHint").textContent = "");
    const start = parseISO(s);
    const end = new Date(start); end.setDate(end.getDate() + n - 1);
    $("#dateHint").textContent = n === 1 ? `📅 ${fmtDate(start)} 하루 여행` : `📅 ${fmtDate(start)} → ${fmtDate(end)}`;
  }

  function initForm() {
    $("#startDate").value = defaultStartDate();
    $("#startDate").min = toISO(new Date());
    updateDateHint();
    $("#startDate").addEventListener("change", updateDateHint);
    $("#duration").addEventListener("change", updateDateHint);

    $$(".stepper button").forEach((b) => b.addEventListener("click", () => setPeople(Number($("#people").value) + Number(b.dataset.step))));
    $("#budget").addEventListener("input", () => setBudget(getBudget()));
    $$("#budgetQuick [data-budget]").forEach((b) => b.addEventListener("click", () => setBudget(b.dataset.budget)));
    $$("#regionQuick [data-region]").forEach((b) => b.addEventListener("click", () => { $("#region").value = b.dataset.region; }));

    $("#planForm").addEventListener("reset", () => setTimeout(() => {
      setPeople(2); setBudget(800000); $("#startDate").value = defaultStartDate(); updateDateHint();
    }));
    $("#planForm").addEventListener("submit", (e) => { e.preventDefault(); generateWithAI(); });
  }

  function readInput() {
    return {
      region: $("#region").value.trim(),
      startDate: $("#startDate").value || defaultStartDate(),
      duration: Number($("#duration").value),
      people: Number($("#people").value),
      budget: getBudget(),
      prefs: $$('input[name="pref"]:checked').map((i) => i.value),
      transport: $('input[name="transport"]:checked').value,
      origin: $("#origin").value.trim() || "서울",
      parking: $("#optParking").checked,
      toll: $("#optToll").checked,
      notes: $("#notes").value.trim(),
    };
  }

  function validateClient(input) {
    if (!input.region) return "여행 지역을 입력해 주세요.";
    if (input.budget < 10000) return "총예산을 1만 원 이상으로 입력해 주세요.";
    return null;
  }

  /* ───────────── 샘플 미리보기 (첫 화면용) ───────────── */
  function pickDataset(region) {
    for (const key of Object.keys(SAMPLE_DATA)) {
      if (SAMPLE_DATA[key].aliases.some((a) => region.includes(a) || a.includes(region))) return { data: SAMPLE_DATA[key], matched: true };
    }
    return { data: SAMPLE_DATA["강릉"], matched: false };
  }

  function buildSamplePlan(input) {
    const { data } = pickDataset(input.region || "강릉");
    const n = input.duration;
    const src = data.days;
    let dayDefs;
    if (n === 1) {
      const last = src[0].stops.at(-1);
      dayDefs = [{ title: "알차게 당일치기", stops: [...src[0].stops.filter((s) => s.type !== "lodging"),
        { time: "20:00", name: `${input.origin}(으)로 귀가`, type: "rest", cost: 0, lat: last.lat, lng: last.lng, driveMin: 0, desc: "졸음 쉼터에서 쉬어가며 안전 운전!" }] }];
    } else {
      dayDefs = [src[0]];
      for (let i = 1; i < n - 1; i++) dayDefs.push(src[i] && i < src.length - 1 ? src[i] : { title: "여유로운 자유 일정", stops: data.extras });
      dayDefs.push(src[src.length - 1]);
    }
    const start = parseISO(input.startDate);
    const days = dayDefs.map((d, i) => {
      const date = new Date(start); date.setDate(date.getDate() + i);
      return {
        index: i, date, title: d.title, weather: data.weather[i % data.weather.length], tip: "",
        stops: d.stops.map((s) => ({ ...s, parking: input.parking && s.type !== "rest", match: input.prefs.includes(TYPE_META[s.type].pref) })),
      };
    });
    return {
      source: "sample", input, days,
      title: `${data.name} ${tripLength(n)} 드라이브`, emoji: data.emoji, tagline: data.tagline,
      eyebrow: "샘플 미리보기 · ‘여행 일정 만들기’를 누르면 AI가 새로 짜 드려요",
      notice: "", tips: [],
      budget: calcSampleBudget(input, data, days),
    };
  }

  function calcSampleBudget(input, data, days) {
    const p = input.people, nDays = days.length, nights = nDays - 1, rooms = Math.ceil(p / 2);
    const all = days.flatMap((d) => d.stops);
    const sum = (types) => all.filter((s) => types.includes(s.type)).reduce((a, s) => a + s.cost, 0) * p;
    const isJeju = data.name === "제주";
    const transport = isJeju && input.transport === "own" ? "rental" : input.transport;
    const localKm = 45 * nDays, fuelPerKm = 1700 / 12;
    const items = [];
    if (isJeju) items.push({ key: "flight", label: "항공권 (왕복)", amount: data.flightPerPerson * p });
    if (transport === "own") {
      items.push({ key: "fuel", label: "유류비", amount: (data.distanceKm * 2 + localKm) * fuelPerKm });
      if (input.toll) items.push({ key: "toll", label: "고속도로 통행료", amount: data.tollWon * 2 });
    } else {
      if (transport === "ktx-rental") items.push({ key: "ktx", label: "KTX 왕복", amount: 55000 * 2 * p });
      items.push({ key: "rental", label: "렌터카 대여", amount: 65000 * nDays * Math.ceil(p / 5) });
      items.push({ key: "fuel", label: "현지 유류비", amount: localKm * fuelPerKm });
    }
    if (nights > 0) items.push({ key: "lodging", label: `숙박 (${nights}박 · 객실 ${rooms}개)`, amount: data.lodgingPerNight * nights * rooms });
    items.push({ key: "food", label: "식비", amount: sum(["food"]) });
    items.push({ key: "sight", label: "관광·입장료", amount: sum(["sight", "history", "nature", "activity"]) });
    items.push({ key: "cafe", label: "카페·쇼핑", amount: sum(["cafe", "shop"]) });
    const subtotal = items.reduce((a, b) => a + b.amount, 0);
    items.push({ key: "reserve", label: "예비비 (10%)", amount: subtotal * 0.1 });
    return finalizeBudget(items, input, nights, "샘플 추정");
  }

  /** AI 예산 항목의 예비비를 금액이 있는 항목 합계의 10%로 다시 계산 (AI에게 맡기면 미확인이 되기 쉬움) */
  function withReserve(items) {
    const rest = items.filter((it) => it.key !== "reserve");
    const known = rest.reduce((a, it) => a + (Number.isFinite(Number(it.amount)) && it.amount !== null ? Number(it.amount) : 0), 0);
    if (!known) return rest;
    return [...rest, { key: "reserve", label: "예비비 (합계의 10%)", amount: Math.round(known * 0.1), status: "estimated", source: "자동 계산" }];
  }

  /** 예산 항목 키 → calculate_budget 카테고리 */
  const KEY_TO_CATEGORY = { flight: "transport", ktx: "transport", rental: "transport", fuel: "transport", toll: "transport", lodging: "lodging", food: "food", sight: "sightseeing", cafe: "shopping", etc: "etc", reserve: "reserve" };

  /**
   * calculate_budget으로 합산·잔여 예산 계산
   * - 샘플/AI 금액은 모두 "추정치", 0원 항목(해당 없음)은 제외
   * - 필수 카테고리(교통·식비, 숙박일 때 숙박)가 빠지면 "미확인"으로 표시
   */
  function finalizeBudget(rawItems, input, nights, source) {
    // 샘플: 상태 없음 → 0원(해당 없음) 제외, 추정치 / AI Agent: 서버 검증된 상태(확인됨·추정치·미확인) 그대로
    const hasAmount = (it) => it.amount !== null && it.amount !== undefined && Number.isFinite(Number(it.amount));
    const items = rawItems.filter((it) => (it.status ? true : hasAmount(it) && Number(it.amount) > 0));
    const calc = calculateBudget({
      totalBudget: input.budget,
      people: input.people,
      required: nights > 0 ? ["transport", "lodging", "food"] : ["transport", "food"],
      items: items.map((it) => ({
        category: KEY_TO_CATEGORY[it.key] || "etc",
        label: it.label,
        amount: hasAmount(it) ? Math.round(Number(it.amount)) : null,
        status: it.status || "estimated",
        source: it.source || source,
      })),
    });
    const rows = calc.items.map((it, i) => ({
      ...it,
      icon: BUDGET_ICON[items[i]?.key] || BUDGET_CATEGORIES[it.category]?.icon || "🧾",
      amount: it.total,
    }));
    return { calc, items: rows, total: calc.totals.known, perPerson: calc.perPerson, limit: input.budget, diff: calc.remaining };
  }

  function buildSampleLog(plan) {
    const { input, days } = plan;
    return [
      { agent: "Planner", icon: "🧭", title: "샘플 미리보기", ms: 0,
        text: `${input.region} · ${tripLength(input.duration)} · ${input.people}명 · 예산 ${manwon(input.budget)} · ${TRANSPORT_LABEL[input.transport]}`,
        detail: { source: "sample-data.js", days: days.length } },
      { agent: "Info", icon: "💡", title: "AI 연결 대기", ms: 0,
        text: "‘여행 일정 만들기’를 누르면 AI Agent가 search_places · get_routes · calculate_budget · web_search 중 필요한 Tool을 골라 실행해요. 실제 호출된 Tool과 결과가 여기에 기록돼요.",
        detail: { endpoint: "POST /api/plan" } },
    ];
  }

  /* ───────────── AI 응답 → 화면용 plan ───────────── */
  /** "1일차 — 바다" → "바다", 날짜만 있으면 "1일차" */
  function cleanDayTitle(raw, i) {
    let t = String(raw || "").replace(/^\s*(DAY\s*\d+|\d+\s*일\s*차)\s*[—\-–:·.)]?\s*/i, "").trim();
    // "2026-12-18 (도착 → 성산)" / "(2026-12-18, 도착일)" → 날짜는 화면에 따로 표시하므로 제거
    t = t.replace(/^\(?\s*\d{4}-\d{2}-\d{2}\s*[,)]?\s*[—\-–:·]?\s*/, "").trim();
    if (/^\(.*\)$/.test(t)) t = t.slice(1, -1).trim();
    if (t.endsWith(")") && !t.includes("(")) t = t.slice(0, -1).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t = "";
    return t || `${i + 1}일차`;
  }
  /** 이모지 여러 개가 오면 첫 글자만 */
  function firstGrapheme(s) {
    if (!s) return "";
    try { return [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(s)][0]?.segment || ""; } catch { return [...s][0] || ""; }
  }

  /** Agent 최종 응답 → 화면용 plan. 서버 검증을 거친 값만 오며, 근거 없는 이동시간·가격·좌표는 null */
  function planFromAI(input, ai, meta) {
    const start = parseISO(input.startDate);
    const numOrNull = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
    const days = ai.days.map((d, i) => {
      const date = new Date(start); date.setDate(date.getDate() + i);
      return {
        index: i, date, weather: "", tip: d.tip,
        title: cleanDayTitle(d.title, i),
        stops: (d.stops || []).map((s) => {
          const type = TYPE_META[s.type] ? s.type : "sight";
          return {
            time: /^\d{1,2}:\d{2}$/.test(String(s.time).trim()) ? String(s.time).trim() : "", name: s.name, type, desc: s.desc, address: s.address || "",
            lat: numOrNull(s.lat), lng: numOrNull(s.lng), placeSource: s.place_source,
            cost: numOrNull(s.cost), costSource: s.cost_source,
            driveMin: numOrNull(s.drive_min), driveKm: numOrNull(s.drive_km), driveSource: s.drive_source,
            parking: false, match: input.prefs.includes(TYPE_META[type].pref),
          };
        }),
      };
    });
    return {
      source: "ai", input, days, meta,
      title: ai.title, emoji: firstGrapheme(ai.emoji) || "🚗", tagline: ai.tagline,
      eyebrow: "AI Agent가 만든 여행 일정",
      notice: ai.region_note, tips: ai.tips || [], references: ai.references || [],
      budget: finalizeBudget(withReserve(ai.budget_items || []), input, input.duration - 1, "AI Agent"),
    };
  }

  /* ───────────── 렌더링 ───────────── */
  function renderSummary(plan) {
    const { input, days, budget } = plan;
    const first = days[0].date, last = days.at(-1).date;
    $("#summary").innerHTML = `
      <div class="summary-main">
        <div class="summary-emoji">${esc(plan.emoji)}</div>
        <div>
          <p class="eyebrow">${plan.source === "ai" ? '<span class="ai-badge">AI</span>' : ""}${esc(plan.eyebrow)}</p>
          <h2>${esc(plan.title)}</h2>
          <p class="muted">${esc(plan.tagline)}</p>
        </div>
      </div>
      <dl class="summary-stats">
        <div><dt>일정</dt><dd>${fmtDate(first)}${days.length > 1 ? ` – ${fmtDate(last)}` : ""}</dd></div>
        <div><dt>인원</dt><dd>${input.people}명</dd></div>
        <div><dt>예상 비용</dt><dd>${manwon(budget.total)}${budget.calc.totals.unknownCount ? ` <small class="muted">+ 미확인 ${budget.calc.totals.unknownCount}건</small>` : ""}</dd></div>
        <div><dt>취향</dt><dd>${input.prefs.length ? input.prefs.map(esc).join(" · ") : "전체"}</dd></div>
      </dl>
      ${plan.notice ? `<p class="summary-notice">📌 ${esc(plan.notice)}</p>` : ""}
      ${input.notes ? `<p class="summary-note">💬 “${esc(input.notes)}”</p>` : ""}
      ${plan.tips.length ? `<ul class="tips">${plan.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      ${plan.references?.length ? `<p class="refs">🌐 웹 검색 출처: ${plan.references.slice(0, 6).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(u)) || `출처 ${i + 1}`}</a>`).join(" · ")}</p>` : ""}`;
  }
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

  function renderTabs(plan) {
    const tabs = [{ id: "all", label: "전체" }, ...plan.days.map((d) => ({ id: d.index, label: `${d.index + 1}일차` }))];
    $("#dayTabs").innerHTML = tabs.map((t) =>
      `<button type="button" role="tab" class="tab ${String(state.activeDay) === String(t.id) ? "active" : ""}" data-day="${t.id}">${t.label}</button>`).join("");
    $$("#dayTabs .tab").forEach((b) => b.addEventListener("click", () => {
      state.activeDay = b.dataset.day === "all" ? "all" : Number(b.dataset.day);
      state.mapMode = "plan";
      state.highlight = null;
      renderTabs(plan); renderItinerary(plan); renderMap(plan);
    }));
  }

  const fmtMin = (m) => (Math.floor(m / 60) ? `${Math.floor(m / 60)}시간 ` : "") + `${m % 60}분`;

  /** 장소 사이 이동 표시: NAVER 경로 결과가 있으면 우선, 없으면 AI/샘플 추정치 (도보·대중교통은 표시하지 않음) */
  function driveLine(plan, d, i, s) {
    const leg = i > 0 ? state.routes?.[d.index]?.legs?.[i - 1] : null;
    if (leg) {
      return leg.status === "ok"
        ? `<li class="drive naver">🚗 자동차 ${leg.distanceKm}km · 약 ${fmtMin(leg.durationMin)} <span class="src">NAVER</span>${leg.note ? ` <span class="muted">· ${esc(leg.note)}</span>` : ""}</li>`
        : `<li class="drive na">🚗 이동 정보 확인 불가 <span class="muted">· ${esc(leg.reason)}</span></li>`;
    }
    if (plan.source === "ai") {
      // Agent가 get_routes로 확인한 값만 표시, 없으면 미확인 (만들어내지 않음)
      if (s.driveSource === "get_routes" && s.driveMin !== null) {
        return `<li class="drive naver">🚗 자동차 ${s.driveKm !== null ? `${s.driveKm}km · ` : ""}약 ${fmtMin(s.driveMin)} <span class="src">get_routes</span></li>`;
      }
      return i > 0 ? `<li class="drive unknown">🚗 이동 시간 미확인 <span class="muted">· 경로 계산 버튼으로 확인할 수 있어요</span></li>` : "";
    }
    if (!s.driveMin) return "";
    return `<li class="drive">🚗 약 ${s.driveMin}분 이동 <span class="src est">${i === 0 ? "출발지 기준 · " : ""}샘플</span></li>`;
  }

  function renderItinerary(plan) {
    const days = state.activeDay === "all" ? plan.days : [plan.days[state.activeDay]];
    $("#itinerary").innerHTML = days.map((d) => {
      const color = DAY_COLORS[d.index % DAY_COLORS.length];
      const route = state.routes?.[d.index];
      const knownCost = d.stops.filter((s) => s.cost !== null);
      const unknownCost = d.stops.length - knownCost.length;
      const costText = plan.source === "ai"
        ? (knownCost.length ? `확인된 비용 ${won(knownCost.reduce((a, s) => a + s.cost, 0) * plan.input.people)}` : "") + (unknownCost ? `${knownCost.length ? " · " : ""}가격 미확인 ${unknownCost}곳` : "")
        : won(d.stops.reduce((a, s) => a + s.cost, 0) * plan.input.people);
      let driveText;
      if (route?.totals) {
        const t = route.totals;
        driveText = `여행지 내 운전 ${fmtMin(t.durationMin)} · ${t.distanceKm}km (NAVER${t.unavailable ? `, 확인 불가 ${t.unavailable}구간 제외` : ""})`;
      } else if (plan.source === "ai") {
        const legs = d.stops.slice(1);
        const okLegs = legs.filter((s) => s.driveSource === "get_routes" && s.driveMin !== null);
        driveText = okLegs.length
          ? `운전 ${fmtMin(okLegs.reduce((a, s) => a + s.driveMin, 0))} (get_routes${okLegs.length < legs.length ? `, 미확인 ${legs.length - okLegs.length}구간` : ""})`
          : "이동 시간 미확인";
      } else {
        const drive = d.stops.reduce((a, s) => a + s.driveMin, 0);
        driveText = `운전 약 ${fmtMin(drive)} (샘플)`;
      }
      const meta = [fmtDate(d.date), d.weather, driveText, costText].filter(Boolean).join(" · ");
      return `
      <article class="day" style="--day:${color}">
        <header class="day-head">
          <span class="day-badge">DAY ${d.index + 1}</span>
          <div>
            <h3>${esc(d.title)}</h3>
            <p class="muted small">${meta}</p>
          </div>
        </header>
        ${d.tip ? `<p class="day-tip">🚗 ${esc(d.tip)}</p>` : ""}
        <ol class="stops">
          ${d.stops.map((s, i) => {
            const m = TYPE_META[s.type];
            const key = `${d.index}-${i}`;
            return `
            ${driveLine(plan, d, i, s)}
            <li class="stop ${state.highlight === key ? "hl" : ""}" data-key="${key}" tabindex="0">
              <span class="stop-num">${i + 1}</span>
              <div class="stop-body">
                <div class="stop-top">
                  <time>${esc(s.time)}</time>
                  <strong>${esc(s.name)}</strong>
                  ${s.match ? `<span class="tag-match">취향 저격</span>` : ""}
                </div>
                <p><span class="why">추천 이유</span> ${esc(s.desc)}</p>
                ${s.address ? `<p class="addr">📍 ${esc(s.address)}</p>` : ""}
                <div class="stop-meta">
                  <span class="type" style="--c:${m.color}">${m.icon} ${m.label}</span>
                  ${s.cost === null ? `<span class="st st-unknown">가격 미확인</span>`
                    : s.cost === 0 ? `<span>무료${s.costSource === "free" ? " (확인됨)" : ""}</span>`
                    : `<span>1인 ${won(s.cost)}${s.costSource === "web_search" ? " · 웹 검색" : ""}</span>`}
                  ${s.parking ? `<span>🅿️ 주차 가능</span>` : ""}
                  ${s.placeSource === "search_places" ? `<span title="${esc(s.address)}">📍 NAVER 검색 장소</span>` : plan.source === "ai" ? `<span class="muted">📍 위치 미확인</span>` : ""}
                </div>
              </div>
            </li>`;
          }).join("")}
        </ol>
      </article>`;
    }).join("");

    $$("#itinerary .stop").forEach((el) => {
      const act = () => {
        state.highlight = state.highlight === el.dataset.key ? null : el.dataset.key;
        state.mapMode = "plan";
        $$("#itinerary .stop").forEach((s) => s.classList.toggle("hl", s.dataset.key === state.highlight));
        renderMap(plan);
      };
      el.addEventListener("click", act);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
    });
  }

  // 한반도 대략 범위 밖 좌표(AI가 잘못 준 값)는 지도에서 제외
  const validCoord = (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && s.lat > 32 && s.lat < 39.5 && s.lng > 124 && s.lng < 132;

  const MAP_W = 600, MAP_H = 460, MAP_PAD = 56;

  /** 위경도 점들이 화면에 꽉 차도록 투영 함수 생성 (경도는 cos(위도)로 보정) */
  function makeProjector(pts) {
    const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const k = Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
    const spanX = Math.max((maxLng - minLng) * k, 0.01), spanY = Math.max(maxLat - minLat, 0.01);
    const scale = Math.min((MAP_W - MAP_PAD * 2) / spanX, (MAP_H - MAP_PAD * 2) / spanY);
    const cx = (minLng + maxLng) / 2, cy = (minLat + maxLat) / 2;
    return (p) => [MAP_W / 2 + (p.lng - cx) * k * scale, MAP_H / 2 - (p.lat - cy) * scale];
  }

  const mapBackground = () => `
      <defs>
        <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <path d="M28 0H0V28" fill="none" stroke="currentColor" stroke-opacity=".07" />
        </pattern>
        <radialGradient id="glow" cx="50%" cy="45%" r="70%">
          <stop offset="0" stop-color="#fff" stop-opacity=".9" /><stop offset="1" stop-color="#fff" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="${MAP_W}" height="${MAP_H}" fill="url(#glow)" />
      <rect width="${MAP_W}" height="${MAP_H}" fill="url(#grid)" />
      <g class="compass" transform="translate(${MAP_W - 36},36)">
        <circle r="16" fill="#fff" stroke="#e6e3dc" /><path d="M0-10 L5 4 L0 1 L-5 4Z" fill="#ff6b4a" /><text y="-20" text-anchor="middle">N</text>
      </g>`;

  function showMapEmpty(msg) {
    $("#mapSvg").innerHTML = `${mapBackground()}<text x="${MAP_W / 2}" y="${MAP_H / 2}" text-anchor="middle" class="map-empty">${esc(msg)}</text>`;
    $("#mapLegend").innerHTML = "";
  }

  function syncMapModeTabs() {
    const box = $("#mapMode");
    box.hidden = !state.places;
    $$(".tab", box).forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mapMode));
  }

  /**
   * 실제 자동차 경로(도로 좌표) 목록 — 있는 것만
   * 1) Agent가 get_routes로 계산한 구간(plan.meta.routes) 2) "경로 계산" 버튼 결과(state.routes)
   */
  function realRoutePaths(plan, days) {
    const want = new Set(days.map((d) => d.index));
    const out = [];
    const seen = new Set();
    for (const [di, legs] of (state.routes || []).entries()) {
      if (!want.has(di)) continue;
      (legs?.legs || []).forEach((l, i) => {
        if (l.status === "ok" && l.path?.length >= 2) { out.push({ day: di, to: i + 1, coords: l.path }); seen.add(`${di}-${i + 1}`); }
      });
    }
    for (const r of plan.meta?.routes || []) {
      if (want.has(r.day) && !seen.has(`${r.day}-${r.to}`)) out.push({ day: r.day, to: r.to, coords: r.path });
    }
    return out.map((r) => ({ ...r, color: DAY_COLORS[r.day % DAY_COLORS.length] }));
  }

  /** 지도 마커 클릭 → 일정 항목 강조 */
  function selectStop(plan, key) {
    const [di] = key.split("-").map(Number);
    state.highlight = key; state.mapMode = "plan";
    if (state.activeDay !== "all" && state.activeDay !== di) { state.activeDay = di; renderTabs(plan); renderItinerary(plan); }
    renderMap(plan);
    const el = $(`#itinerary .stop[data-key="${key}"]`);
    $$("#itinerary .stop").forEach((x) => x.classList.toggle("hl", x === el));
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function setMapEngine(naverOn) {
    $("#naverMap").hidden = !naverOn;
    $("#mapSvg").style.display = naverOn ? "none" : "";
  }

  function renderMap(plan) {
    syncMapModeTabs();
    if (state.mapMode === "places" && state.places) return renderPlacesMap();
    const svg = $("#mapSvg");
    const days = state.activeDay === "all" ? plan.days : [plan.days[state.activeDay]];
    const pts = days.flatMap((d) => d.stops).filter(validCoord);
    const paths = realRoutePaths(plan, days);
    const naverOn = isNaverReady();
    setMapEngine(naverOn);
    $("#mapBadge").textContent = naverOn
      ? `NAVER 지도${paths.length ? ` · 실제 경로 ${paths.length}구간` : ""}`
      : plan.source === "ai" ? "NAVER 검색 좌표 · 미리보기 지도" : "지도 API 연결 전 · 미리보기";
    const note = $("#mapNote");
    const routeMsg = paths.length
      ? "선은 NAVER 길찾기로 계산된 실제 자동차 경로예요. 경로가 계산되지 않은 구간은 선을 그리지 않아요."
      : "실제 자동차 경로 정보가 없어 마커만 표시해요. ‘NAVER 자동차 경로 계산’을 누르면 경로를 그려요.";
    const fallbackMsg = !naverOn && state.mapFallback ? `⚠️ ${state.mapFallback} — 미리보기 지도로 표시해요. ` : "";
    note.hidden = !(fallbackMsg || plan.source === "ai" || state.routes);
    note.textContent = fallbackMsg + (plan.source === "ai" || state.routes ? routeMsg : "");

    if (naverOn) {
      drawNaverMap({
        points: days.flatMap((d) => d.stops.map((s, i) => validCoord(s) ? { key: `${d.index}-${i}`, lat: s.lat, lng: s.lng, label: i + 1, color: DAY_COLORS[d.index % DAY_COLORS.length], title: `${d.index + 1}일차 ${i + 1}. ${s.name}` } : null)).filter(Boolean),
        paths,
        highlight: state.highlight,
        onSelect: (key) => selectStop(plan, key),
      });
      $("#mapLegend").innerHTML = days.map((d) => `<span><i style="background:${DAY_COLORS[d.index % DAY_COLORS.length]}"></i>${d.index + 1}일차 · ${fmtDate(d.date)}</span>`).join("");
      return;
    }

    if (!pts.length) return showMapEmpty("표시할 좌표가 없어요");
    const proj = makeProjector(pts);

    // 미리보기 지도: 실제 경로는 실선, 경로 정보가 없으면 방문 순서만 점선
    const realLines = paths.map((p) => {
      const d = p.coords.map(([lng, lat], i) => { const [x, y] = proj({ lat, lng }); return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ");
      return `<path d="${d}" class="route-real" stroke="${p.color}" />`;
    }).join("");
    const routes = days.map((d) => {
      const color = DAY_COLORS[d.index % DAY_COLORS.length];
      const xy = d.stops.filter(validCoord).map(proj);
      if (xy.length < 2) return "";
      const path = xy.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
      return `<path d="${path}" class="route${paths.length ? " faint" : ""}" stroke="${color}" />`;
    }).join("") + realLines;

    const markers = days.map((d) => {
      const color = DAY_COLORS[d.index % DAY_COLORS.length];
      const seen = new Set();
      return d.stops.map((s, i) => {
        if (!validCoord(s)) return "";
        const [x, y] = proj(s);
        const posKey = `${x.toFixed(0)},${y.toFixed(0)}`;
        if (seen.has(posKey) && s.driveMin === 0) return "";
        seen.add(posKey);
        const key = `${d.index}-${i}`;
        const hl = state.highlight === key;
        return `<g class="marker ${hl ? "hl" : ""}" data-key="${key}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
          ${hl ? `<circle r="22" class="pulse" fill="${color}" />` : ""}
          <circle r="${hl ? 15 : 12}" fill="${color}" stroke="#fff" stroke-width="3" />
          <text text-anchor="middle" dy="4.5">${i + 1}</text>
        </g>`;
      }).join("");
    }).join("");

    svg.innerHTML = `${mapBackground()}${routes}${markers}`;

    const tip = $("#mapTooltip");
    $$(".marker", svg).forEach((g) => {
      const [di, si] = g.dataset.key.split("-").map(Number);
      const s = plan.days[di].stops[si];
      g.addEventListener("mouseenter", () => {
        const m = TYPE_META[s.type];
        tip.innerHTML = `<b>${di + 1}일차 · ${si + 1}. ${esc(s.name)}</b><span>${esc(s.time)} · ${m.icon} ${m.label}</span>`;
        const box = $("#map").getBoundingClientRect(), gb = g.getBoundingClientRect();
        tip.style.left = gb.left - box.left + gb.width / 2 + "px";
        tip.style.top = gb.top - box.top + "px";
        tip.hidden = false;
      });
      g.addEventListener("mouseleave", () => (tip.hidden = true));
      g.addEventListener("click", () => {
        state.highlight = g.dataset.key;
        renderMap(plan);
        const el = $(`#itinerary .stop[data-key="${g.dataset.key}"]`);
        $$("#itinerary .stop").forEach((x) => x.classList.toggle("hl", x === el));
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });

    $("#mapLegend").innerHTML = days.map((d) =>
      `<span><i style="background:${DAY_COLORS[d.index % DAY_COLORS.length]}"></i>${d.index + 1}일차 · ${fmtDate(d.date)}</span>`).join("");
  }

  function renderBudget(plan) {
    const b = plan.budget, c = b.calc;
    const over = c.status === "over";
    const usedPct = b.limit ? Math.min(100, (b.total / b.limit) * 100) : 0;
    const badge = $("#budgetBadge");
    badge.className = "pill " + (over ? "pill-warn" : c.status === "tight" ? "pill-run" : "pill-ok");
    badge.textContent = over ? `${manwon(-b.diff)} 초과` : `잔여 ${manwon(b.diff)}`;

    const known = b.items.filter((it) => it.status !== "unknown").sort((a, x) => x.amount - a.amount);
    const unknown = b.items.filter((it) => it.status === "unknown");
    const palette = ["#ff6b4a", "#ffa24a", "#2fa37a", "#5b7cfa", "#9a6bd8", "#d65db1", "#3d8bd9", "#8a8fa3", "#b07a4f", "#6bb7c7", "#c4a24a"];
    const tag = (it) => `<span class="st st-${it.status}" title="${esc(it.source || "")}">${it.statusLabel}</span>`;
    const r = state.routesSummary;
    $("#budgetView").innerHTML = `
      <div class="budget-top">
        <div><p class="muted small">예상 총 비용</p><p class="big">${won(b.total)}</p><p class="muted small">1인당 약 ${won(b.perPerson)}</p></div>
        <div class="right"><p class="muted small">설정한 예산</p><p class="mid">${won(b.limit)}</p>
          <p class="small ${over ? "warn-text" : "ok-text"}">잔여 ${won(b.diff)}</p></div>
      </div>
      <div class="meter ${over ? "over" : ""}" role="img" aria-label="예산 사용률 ${Math.round(usedPct)}%">
        <div class="meter-fill" style="width:${usedPct}%"></div>
      </div>
      <p class="small ${over ? "warn-text" : "ok-text"}">${c.statusLabel} · 예산의 ${b.limit ? Math.round((b.total / b.limit) * 100) : 0}% 사용 예정${over ? " · 숙소 등급이나 유료 일정을 조정해 보세요" : ""}</p>
      <div class="budget-split">
        <span><span class="st st-confirmed">확인됨</span> ${won(c.totals.confirmed)}</span>
        <span><span class="st st-estimated">추정치</span> ${won(c.totals.estimated)}</span>
        <span><span class="st st-unknown">미확인</span> ${c.totals.unknownCount}건</span>
      </div>
      <div class="stack">${known.map((it, i) => `<span style="flex:${it.amount};background:${palette[i % palette.length]}" title="${esc(it.label)} ${won(it.amount)}"></span>`).join("")}</div>
      <div class="table-wrap">
        <table class="budget-table">
          <caption class="sr-only">예상 비용과 잔여 예산</caption>
          <thead><tr><th scope="col">항목</th><th scope="col">근거</th><th scope="col" class="num">금액</th><th scope="col" class="num">비율</th></tr></thead>
          <tbody>
            ${known.map((it, i) => `
              <tr>
                <td><span class="dot" style="background:${palette[i % palette.length]}"></span>${it.icon} ${esc(it.label)}</td>
                <td>${tag(it)}${it.source ? `<small class="src-note">${esc(it.source)}</small>` : ""}</td>
                <td class="num">${won(it.amount)}</td>
                <td class="num muted">${b.total ? Math.round((it.amount / b.total) * 100) : 0}%</td>
              </tr>`).join("")}
            ${unknown.map((it) => `
              <tr class="unknown">
                <td><span class="dot"></span>${it.icon} ${esc(it.label)}</td>
                <td>${tag(it)}${it.source ? `<small class="src-note">${esc(it.source)}</small>` : ""}</td>
                <td class="num">미확인</td>
                <td class="num muted">–</td>
              </tr>`).join("")}
          </tbody>
          <tfoot>
            <tr><th scope="row" colspan="2">예상 비용 합계 <small class="muted">(확인됨 + 추정치)</small></th><td class="num">${won(b.total)}</td><td></td></tr>
            ${c.totals.unknownCount ? `<tr class="unknown"><th scope="row" colspan="2">미확인 항목</th><td class="num">${c.totals.unknownCount}건</td><td></td></tr>` : ""}
            <tr><th scope="row" colspan="2">총예산</th><td class="num">${won(b.limit)}</td><td></td></tr>
            <tr class="${over ? "over" : "remain"}"><th scope="row" colspan="2">잔여 예산</th><td class="num">${won(b.diff)}</td><td class="num">${b.limit ? Math.round((b.diff / b.limit) * 100) : 0}%</td></tr>
          </tfoot>
        </table>
      </div>
      ${r ? `<p class="route-ref">🚗 <b>NAVER 경로 기준 여행지 내 이동</b> ${r.distanceKm}km · 통행료 ${won(r.tollFare)} <span class="st st-confirmed">확인됨</span> · 유류비 약 ${won(r.fuelPrice)} <span class="st st-estimated">추정치</span><br><span class="muted">출발지 왕복은 포함되지 않아 위 교통비와 따로 보여드려요${r.unavailable ? ` · 확인 불가 구간 ${r.unavailable}개 제외` : ""}.</span></p>` : ""}
      ${c.warnings.length ? `<ul class="budget-warn">${c.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}`;
  }

  function renderAll(plan) {
    renderSummary(plan); renderTabs(plan); renderItinerary(plan); renderMap(plan); renderBudget(plan); renderSources(plan);
  }

  /** 실제로 사용된 데이터 출처 (Agent가 호출한 Tool과 웹 검색 결과) */
  function renderSources(plan) {
    const badge = $("#sourcesBadge"), view = $("#sourcesView");
    if (plan.source !== "ai") {
      badge.textContent = "샘플";
      view.innerHTML = `<p class="muted small">지금은 샘플 데이터(sample-data.js)로 만든 미리보기예요. ‘여행 일정 만들기’를 누르면 Agent가 실제로 사용한 출처가 여기에 표시돼요.</p>`;
      return;
    }
    const src = plan.meta?.sources || {};
    const stops = plan.days.flatMap((d) => d.stops);
    const placed = stops.filter((s) => s.placeSource === "search_places").length;
    const driven = stops.filter((s) => s.driveSource === "get_routes").length;
    const routeLines = plan.meta?.routes?.length || 0;
    const queries = src.naver_search?.queries || [];
    const web = [...new Set([...(plan.references || []), ...(src.web || [])])];
    badge.textContent = `${[queries.length && "NAVER 검색", src.naver_directions?.legs && "NAVER 길찾기", web.length && "웹"].filter(Boolean).join(" · ") || "Tool 미사용"}`;
    view.innerHTML = `
      <ul class="src-list">
        <li>
          <span class="src-ic">📍</span>
          <div><b>NAVER API HUB 지역 검색</b> <span class="muted small">search_places · ${queries.length}회</span>
            <p class="small">일정 ${stops.length}곳 중 <b>${placed}곳</b>의 장소명·주소·좌표가 검색 결과에서 왔어요${stops.length - placed ? ` (나머지 ${stops.length - placed}곳은 위치 미확인)` : ""}.</p>
            ${queries.length ? `<div class="chips q-chips">${queries.map((q) => `<span class="chip-q">${esc(q.query)} <small>${q.count}곳</small></span>`).join("")}</div>` : ""}
          </div>
        </li>
        <li>
          <span class="src-ic">🚗</span>
          <div><b>NAVER Maps Directions 5</b> <span class="muted small">get_routes · ${src.naver_directions?.legs || 0}구간 계산</span>
            <p class="small">이동시간 <b>${driven}구간</b>이 실제 자동차 경로 기준이고, 지도에 실제 경로 <b>${routeLines}구간</b>을 그렸어요.</p>
          </div>
        </li>
        <li>
          <span class="src-ic">🌐</span>
          <div><b>웹 검색</b> <span class="muted small">web_search · ${plan.meta?.web_searches || 0}회</span>
            ${src.web_queries?.length ? `<p class="small muted">검색어: ${src.web_queries.map(esc).join(" · ")}</p>` : ""}
            ${web.length ? `<ol class="web-src">${web.slice(0, 8).map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(u) || u)}</a> <span class="muted">${esc(shortPath(u))}</span></li>`).join("")}</ol>` : `<p class="small muted">이번 일정에서는 웹 검색 출처가 없어요.</p>`}
          </div>
        </li>
        <li>
          <span class="src-ic">🤖</span>
          <div><b>OpenAI ${esc(plan.meta?.model || "")}</b> <span class="muted small">일정 구성·설명</span>
            <p class="small">추천 이유와 일정 구성은 AI가 작성했어요. Tool로 확인되지 않은 이동시간·가격은 ‘미확인’으로 표시해요.</p>
          </div>
        </li>
      </ul>`;
  }
  const shortPath = (u) => { try { const p = new URL(u).pathname; return p.length > 32 ? p.slice(0, 32) + "…" : p === "/" ? "" : p; } catch { return ""; } };

  /* ───────────── Agent 실행 기록 ───────────── */
  const clock = (d = new Date()) => d.toTimeString().slice(0, 8);
  const fmtSec = (ms) => (ms / 1000).toFixed(1) + "s";

  function logItemHTML(e, status, t, ms) {
    const icon = status === "running" ? '<span class="spinner"></span>' : status === "error" ? "⚠️" : e.icon;
    return `
      <li class="log-item ${status} ${e.warn ? "warn" : ""}" data-tool="${esc(e.tool || e.agent)}">
        <span class="log-icon">${icon}</span>
        <div class="log-body">
          <div class="log-top">
            <span class="agent agent-${e.agent.toLowerCase()}">${esc(e.agent)}</span>
            <code>${esc(e.title)}</code>
            <time>${t}</time>
          </div>
          <p>${esc(e.text)}</p>
          ${status !== "running" && e.detail ? `<details><summary>상세 보기</summary><pre>${esc(JSON.stringify(e.detail, null, 2))}</pre></details>` : ""}
        </div>
        ${status !== "running" && ms ? `<span class="log-ms">${fmtSec(ms)}</span>` : ""}
      </li>`;
  }

  const logger = {
    reset() {
      $("#agentLog").innerHTML = "";
      traceFilter = "all";
      renderTraceFilter();
      this.setStatus("run", "실행 중");
    },
    setStatus(kind, text) {
      const s = $("#logStatus");
      s.className = "pill " + { run: "pill-run", ok: "pill-ok", error: "pill-warn", idle: "pill-muted" }[kind];
      s.textContent = text;
    },
    /** 단계 시작 → { update(text), done(patch), fail(text, detail) } */
    step(entry, { scroll = true } = {}) {
      const list = $("#agentLog");
      const t = clock(), started = performance.now();
      let cur = { ...entry };
      list.insertAdjacentHTML("beforeend", logItemHTML(cur, "running", t));
      let li = list.lastElementChild;
      if (scroll) li.scrollIntoView({ behavior: "smooth", block: "nearest" });
      else list.scrollTop = list.scrollHeight;
      const replace = (status) => {
        const ms = performance.now() - started;
        li.insertAdjacentHTML("afterend", logItemHTML(cur, status, t, ms));
        const next = li.nextElementSibling; li.remove(); li = next;
        renderTraceFilter();
      };
      return {
        update(text) { cur.text = text; $("p", li).textContent = text; },
        done(patch = {}) { cur = { ...cur, ...patch }; replace("done"); },
        fail(text, detail) { cur = { ...cur, text, detail, warn: true }; replace("error"); },
      };
    },
    renderStatic(entries) {
      $("#agentLog").innerHTML = entries.map((e) => logItemHTML(e, "done", clock(), e.ms)).join("");
      this.setStatus("idle", "샘플 · AI 대기 중");
      traceFilter = "all";
      renderTraceFilter();
    },
  };

  /* Agent Trace — 호출된 Tool별 개수 + 필터 */
  const TRACE_TOOLS = ["search_places", "get_routes", "calculate_budget", "web_search"];
  let traceFilter = "all";
  function renderTraceFilter() {
    const items = $$("#agentLog .log-item");
    const count = (t) => items.filter((li) => li.dataset.tool === t && !li.classList.contains("running")).length;
    const llm = count("LLM");
    const tools = TRACE_TOOLS.map((t) => [t, count(t)]).filter(([, n]) => n > 0);
    const box = $("#traceFilter");
    if (!tools.length && !llm) { box.innerHTML = ""; traceFilter = "all"; applyTraceFilter(); return; }
    box.innerHTML = `<span class="tf-label">호출된 Tool</span>`
      + [["all", "전체", items.length], ...tools.map(([t, n]) => [t, t, n]), ...(llm ? [["LLM", "LLM 호출", llm]] : [])]
        .map(([key, label, n]) => `<button type="button" class="tf ${traceFilter === key ? "active" : ""}" data-f="${key}">${label} <b>${n}</b></button>`).join("");
    $$(".tf", box).forEach((b) => b.addEventListener("click", () => { traceFilter = b.dataset.f; renderTraceFilter(); }));
    applyTraceFilter();
  }
  function applyTraceFilter() {
    $$("#agentLog .log-item").forEach((li) => { li.hidden = traceFilter !== "all" && li.dataset.tool !== traceFilter; });
  }

  /* ───────────── 로딩 / 오류 UI ───────────── */
  function setLoading(on) {
    state.running = on;
    const btn = $("#submitBtn");
    btn.disabled = on;
    btn.classList.toggle("loading", on);
    $(".btn-label", btn).textContent = on ? "AI가 일정을 짜는 중…" : state.plan?.source === "ai" ? "✨ 다시 만들기" : "✨ 여행 일정 만들기";
    $("#result").classList.toggle("pending", on);
    $("#result").setAttribute("aria-busy", String(on));
    $("#loadingBanner").hidden = !on;
  }

  function showError(message) {
    const box = $("#errorBox");
    $("#errorMsg").textContent = message;
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  const hideError = () => ($("#errorBox").hidden = true);

  /* ───────────── API 호출 ───────────── */
  class PlanError extends Error {
    constructor(message, info = {}) { super(message); Object.assign(this, info); }
  }

  /**
   * POST /api/plan — Agent 실행. 서버가 NDJSON으로 Trace 이벤트를 흘려보내면 onEvent로 전달하고,
   * 마지막 {type:"result"}를 돌려줍니다. {type:"error"}면 PlanError.
   */
  async function requestPlan(input, onEvent) {
    if (location.protocol === "file:") {
      throw new PlanError("파일을 직접 열면 서버에 연결할 수 없어요. 터미널에서 `npm start` 실행 후 http://localhost:3000 으로 접속해 주세요.", { code: "file_protocol" });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS);
    const timeoutError = () => new PlanError(`${CLIENT_TIMEOUT_MS / 1000}초가 지나도 완료되지 않았어요. 잠시 후 다시 시도해 주세요.`, { code: "client_timeout" });
    try {
      let res;
      try {
        res = await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: ctrl.signal });
      } catch (err) {
        if (err.name === "AbortError") throw timeoutError();
        throw new PlanError("서버에 연결할 수 없어요. 서버(npm start)가 실행 중인지 확인해 주세요.", { code: "network" });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new PlanError(body?.error || `서버 오류가 발생했어요. (HTTP ${res.status})`, { code: body?.code || "http_" + res.status, status: res.status });
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", result = null;
      const handle = (line) => {
        if (!line.trim()) return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === "result") result = ev;
        else if (ev.type === "error") throw new PlanError(ev.error || "Agent 실행 중 오류가 발생했어요.", { code: ev.code });
        else onEvent(ev);
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
        }
        handle(buf);
      } catch (err) {
        if (err instanceof PlanError) throw err;
        if (err.name === "AbortError") throw timeoutError();
        throw new PlanError("서버와의 연결이 중간에 끊겼어요. 다시 시도해 주세요.", { code: "stream_broken" });
      }
      if (!result) throw new PlanError("Agent 응답이 완료되지 않았어요. 다시 시도해 주세요.", { code: "no_result" });
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 서버 Agent 이벤트 → Agent Trace 단계 */
  function makeTraceHandler() {
    const steps = new Map();       // tool call id → step
    let modelStep = null;
    const short = (v, n = 90) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; };
    const argText = (name, a) => {
      if (!a) return "";
      if (name === "search_places") return `"${a.region} ${a.keyword}"`;
      if (name === "get_routes") return `${a.legs?.length ?? 0}구간: ${(a.legs || []).slice(0, 2).map((l) => `${l.from?.name}→${l.to?.name}`).join(", ")}${a.legs?.length > 2 ? " …" : ""}`;
      if (name === "calculate_budget") return `항목 ${a.items?.length ?? 0}개 · 총예산 ${won(a.total_budget || 0)}`;
      return short(a);
    };
    return (ev) => {
      switch (ev.type) {
        case "model_start":
          modelStep = logger.step({ agent: "LLM", icon: "🧠", title: `Responses API 호출 #${ev.turn}${ev.forceFinal ? " (최종 답변 요청)" : ""}`, text: "다음 행동을 결정하는 중…" });
          break;
        case "model_done": {
          const picks = ev.functionCalls.length ? `Tool 선택: ${ev.functionCalls.join(", ")}` : "";
          const ws = ev.webSearches ? `web_search ${ev.webSearches}회 실행` : "";
          modelStep?.done({ text: [picks, ws].filter(Boolean).join(" · ") || "최종 일정 작성", detail: { turn: ev.turn, function_calls: ev.functionCalls, web_searches: ev.webSearches, ms: ev.ms } });
          modelStep = null;
          break;
        }
        case "web_search":
          logger.step({ agent: "Tool", tool: "web_search", icon: "🌐", title: `web_search (${ev.action || "search"})` }).done({
            text: ev.queries?.length ? `검색어: ${ev.queries.join(" | ")}` : ev.url ? `페이지 열기: ${ev.url}` : "웹 검색",
            detail: { queries: ev.queries, sources: ev.sources, status: ev.status },
          });
          break;
        case "tool_call":
          steps.set(ev.id, logger.step({ agent: "Tool", tool: ev.name, icon: { search_places: "🔎", get_routes: "🚗", calculate_budget: "💰" }[ev.name] || "🔧", title: `${ev.name}(${argText(ev.name, ev.args)})`, text: "실행 중…" }));
          break;
        case "tool_result": {
          const st = steps.get(ev.id);
          if (!st) break;
          if (ev.ok) st.done({ text: ev.summary, warn: /확인 불가|0곳/.test(ev.summary), detail: { tool: ev.name, ms: ev.ms } });
          else st.fail(ev.summary, { tool: ev.name });
          break;
        }
        case "tool_skipped":
          logger.step({ agent: "Tool", tool: ev.name, icon: "⏭️", title: `${ev.name} (건너뜀)` }).fail("Tool 호출 한도를 넘어 실행하지 않았어요.");
          break;
        case "round_trip":
          logger.step({ agent: "Server", tool: "get_routes", icon: "🚗", title: `출발지 왕복 경로 (${ev.origin} ↔ ${ev.region})` }).done({
            text: `왕복 ${Math.round(ev.distanceKm)}km · ${ev.durationMin}분 · 유류비 ${won(ev.fuelPrice)}${ev.tollFare !== null ? ` · 통행료 ${won(ev.tollFare)}` : ""}`,
          });
          break;
        case "nudge":
          logger.step({ agent: "Agent", icon: "🔁", title: "최종 답변 보완 요청" }).done({ text: ev.gaps.join(" "), warn: true });
          break;
        case "limit":
          logger.step({ agent: "Agent", icon: "⛔", title: "반복 한도 도달" }).done({
            text: { max_turns: "최대 반복 횟수", max_tool_calls: "최대 Tool 호출 수", deadline: "시간 제한" }[ev.reason] + "에 도달해 지금까지의 결과로 최종 답변을 요청해요.", warn: true,
          });
          break;
        case "final": {
          const f = ev.verification.fixes;
          logger.step({ agent: "Validator", icon: "🔍", title: "Tool 근거 검증" }).done({
            text: (ev.verification.total
              ? `근거 없는 값 ${ev.verification.total}개를 미확인으로 바꿨어요 (이동시간 ${f.drives} · 가격 ${f.costs} · 예산 ${f.budget} · 좌표 ${f.coords} · 출처 ${f.references})`
              : "모든 이동시간·가격·좌표가 Tool 결과에 근거해요")
              + (ev.verification.filled ? ` · 실제 계산된 경로로 이동시간 ${ev.verification.filled}곳 보정` : "")
              + (ev.routes ? ` · 지도 경로 ${ev.routes}구간` : ""),
            warn: ev.verification.total > 0, detail: ev.verification,
          });
          break;
        }
      }
    };
  }

  async function generateWithAI() {
    if (state.running) return;
    hideError();
    const input = readInput();
    const invalid = validateClient(input);
    if (invalid) return showError(invalid);

    setLoading(true);
    logger.reset();
    $("#result").scrollIntoView({ behavior: "smooth", block: "start" });

    logger.step({ agent: "Client", icon: "🧭", title: "입력 확인" }).done({
      text: `${input.region} · ${tripLength(input.duration)} · ${input.people}명 · 예산 ${manwon(input.budget)} · ${TRANSPORT_LABEL[input.transport]}`,
      detail: input,
    });

    const t0 = performance.now();
    const ticker = setInterval(() => logger.setStatus("run", `Agent 실행 중 · ${Math.round((performance.now() - t0) / 1000)}초`), 1000);

    try {
      const { plan: ai, meta } = await requestPlan(input, makeTraceHandler());
      clearInterval(ticker);
      const plan = planFromAI(input, ai, meta);

      const b = plan.budget;
      logger.step({ agent: "Client", icon: "🧮", title: "예산 집계 (calculate_budget 함수, 브라우저)" }).done({
        text: `합계 ${won(b.total)} (확인됨 ${won(b.calc.totals.confirmed)} · 추정치 ${won(b.calc.totals.estimated)} · 미확인 ${b.calc.totals.unknownCount}건) · 잔여 ${won(b.diff)}`,
        warn: b.calc.status === "over" || b.calc.totals.unknownCount > 0,
        detail: { totals: b.calc.totals, remaining: b.calc.remaining, items: b.items.map((i) => ({ label: i.label, total: i.total, status: i.status, source: i.source })) },
      });

      state.plan = plan; state.activeDay = "all"; state.highlight = null; state.mapMode = "plan";
      state.routes = null; state.routesSummary = null;
      renderAll(plan);
      const u = meta.usage;
      const toolCounts = meta.tool_calls.reduce((m, t) => ((m[t.name] = (m[t.name] || 0) + 1), m), {});
      logger.step({ agent: "Agent", icon: "✅", title: "완료" }).done({
        text: `${meta.turns}턴 · Tool ${Object.entries(toolCounts).map(([k, v]) => `${k}×${v}`).join(", ") || "없음"}${meta.web_searches ? ` · web_search×${meta.web_searches}` : ""} · ${fmtSec(meta.duration_ms)}${u ? ` · 토큰 ${u.total_tokens.toLocaleString()}` : ""}`,
        detail: meta,
      });
      logger.setStatus("ok", `완료 · ${fmtSec(performance.now() - t0)}`);
      // 경로 계산은 Agent(LLM)가 필요할 때 get_routes로 직접 호출합니다. 화면의 버튼으로 수동 계산도 가능.
    } catch (err) {
      clearInterval(ticker);
      const message = err instanceof PlanError ? err.message : "일정을 만드는 중 알 수 없는 오류가 발생했어요.";
      logger.step({ agent: "Agent", icon: "⚠️", title: "실행 실패" }).fail(message, { code: err.code || "unknown", status: err.status ?? null });
      logger.setStatus("error", "실패");
      showError(message);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  /* ───────────── 장소 검색 (NAVER API HUB · search_places) ───────────── */
  const PLACE_KEYWORDS = ["관광지", "맛집", "카페", "해변", "시장", "박물관", "산책로", "체험"];
  const PREF_TO_KEYWORD = { 맛집: "맛집", 관광: "관광지", 자연: "산책로", 휴식: "해변", 쇼핑: "시장", 카페: "카페", 역사: "박물관", 액티비티: "체험" };
  const GROUP_COLORS = ["#ff6b4a", "#2fa37a", "#5b7cfa", "#ef9a1a", "#9a6bd8", "#d65db1"];
  let chipsTouched = false;

  function renderPlaceChips() {
    const prefs = $$('input[name="pref"]:checked').map((i) => i.value);
    const selected = chipsTouched
      ? $$("#placesChips input:checked").map((i) => i.value)
      : [...new Set(prefs.map((p) => PREF_TO_KEYWORD[p]).filter(Boolean))].slice(0, 3);
    const initial = selected.length ? selected : ["관광지", "맛집", "카페"];
    $("#placesChips").innerHTML = PLACE_KEYWORDS.map((k) =>
      `<label class="chip chip-xs"><input type="checkbox" value="${k}" ${initial.includes(k) ? "checked" : ""} /><span>${k}</span></label>`).join("");
  }

  function placesKeywords() {
    const picked = $$("#placesChips input:checked").map((i) => i.value);
    const custom = $("#placesKeyword").value.trim();
    return [...new Set([...(custom ? [custom] : []), ...picked])].slice(0, 6);
  }

  function setPlacesStatus(kind, text) {
    const s = $("#placesStatus");
    s.className = "pill " + { idle: "pill-muted", run: "pill-run", ok: "pill-ok", error: "pill-warn" }[kind];
    s.textContent = text;
  }

  async function runPlaceSearch() {
    if (state.searching) return;
    const region = $("#placesRegion").value.trim();
    const keywords = placesKeywords();
    $("#placesError").hidden = true;
    if (!region || !keywords.length) {
      $("#placesErrorMsg").textContent = !region ? "검색할 여행 지역을 입력해 주세요." : "키워드를 하나 이상 고르거나 직접 입력해 주세요.";
      $("#placesError").hidden = false;
      return;
    }
    if (location.protocol === "file:") {
      $("#placesErrorMsg").textContent = "파일을 직접 열면 서버에 연결할 수 없어요. `npm start` 후 http://localhost:3000 으로 접속해 주세요.";
      $("#placesError").hidden = false;
      return;
    }

    state.searching = true;
    const btn = $("#placesBtn");
    btn.disabled = true; btn.classList.add("loading"); btn.textContent = "검색 중…";
    $("#placesResults").classList.add("is-loading");
    setPlacesStatus("run", "검색 중");
    const step = logger.step({ agent: "Tool", tool: "search_places", icon: "🔎", title: `search_places("${region}", [${keywords.join(", ")}])`, text: "NAVER 지역 검색 API 호출 중…" }, { scroll: false });

    try {
      const qs = new URLSearchParams({ region, keywords: keywords.join(",") });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      let res;
      try { res = await fetch(`/api/places?${qs}`, { signal: ctrl.signal }); }
      catch (e) { throw new Error(e.name === "AbortError" ? "검색 응답이 너무 늦어요. 다시 시도해 주세요." : "서버에 연결할 수 없어요. 서버(npm start)가 실행 중인지 확인해 주세요."); }
      finally { clearTimeout(timer); }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.groups) throw new Error(body?.error || `검색 중 오류가 발생했어요. (HTTP ${res.status})`);

      let n = 0;
      body.groups.forEach((g, gi) => { g.color = GROUP_COLORS[gi % GROUP_COLORS.length]; g.places.forEach((p) => (p.no = ++n)); });
      state.places = body; state.placeHL = null; state.mapMode = "places";
      renderPlaces(); renderMap(state.plan);

      const withCoord = body.groups.flatMap((g) => g.places).filter((p) => p.hasCoord).length;
      setPlacesStatus(body.errors.length ? "error" : "ok", `${n}곳${body.errors.length ? ` · 실패 ${body.errors.length}` : ""}`);
      step.done({
        text: `${body.groups.map((g) => `${g.keyword} ${g.places.length}곳`).join(" · ")} · 좌표 ${withCoord}/${n}${body.errors.length ? ` · 실패: ${body.errors.map((e) => e.keyword).join(", ")}` : ""}`,
        warn: body.errors.length > 0,
        detail: { source: body.meta?.source, duration_ms: body.meta?.duration_ms, queries: body.groups.map((g) => ({ query: g.query, total: g.total, returned: g.places.length })), errors: body.errors },
      });
    } catch (err) {
      $("#placesErrorMsg").textContent = err.message;
      $("#placesError").hidden = false;
      setPlacesStatus("error", "실패");
      step.fail(err.message);
    } finally {
      state.searching = false;
      btn.disabled = false; btn.classList.remove("loading"); btn.textContent = "검색";
      $("#placesResults").classList.remove("is-loading");
    }
  }

  const naverMapLink = (p) => `https://map.naver.com/p/search/${encodeURIComponent(`${p.name} ${p.roadAddress || p.address}`.trim())}`;

  function renderPlaces() {
    const data = state.places;
    if (!data) return;
    const html = data.groups.map((g) => `
      <section class="place-group" style="--g:${g.color}">
        <h3><span class="g-dot"></span>${esc(g.keyword)} <small class="muted">“${esc(g.query)}” · ${g.places.length}곳</small></h3>
        ${g.places.length ? `<ul class="place-list">${g.places.map((p) => `
          <li class="place ${state.placeHL === p.no ? "hl" : ""}" data-no="${p.no}" tabindex="0">
            <span class="place-no">${p.no}</span>
            <div class="place-body">
              <div class="place-top">
                <strong>${esc(p.name)}</strong>
                ${p.category ? `<span class="place-cat">${esc(p.categoryPath.at(-1) || p.category)}</span>` : ""}
              </div>
              ${p.roadAddress ? `<p class="place-addr">${esc(p.roadAddress)}</p>` : ""}
              ${p.address && p.address !== p.roadAddress ? `<p class="place-addr sub">지번 ${esc(p.address)}</p>` : ""}
              ${p.description ? `<p class="place-desc">${esc(p.description)}</p>` : ""}
              <div class="place-meta">
                ${p.category ? `<span title="NAVER 카테고리">${esc(p.category)}</span>` : ""}
                <span class="mono" title="WGS84 위도, 경도">${p.hasCoord ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : "좌표 없음"}</span>
                <a href="${naverMapLink(p)}" target="_blank" rel="noopener noreferrer">네이버 지도 ↗</a>
                ${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">웹사이트 ↗</a>` : ""}
              </div>
            </div>
          </li>`).join("")}</ul>` : `<p class="empty">검색 결과가 없어요. 다른 키워드로 찾아보세요.</p>`}
      </section>`).join("");
    const errs = data.errors.length ? `<p class="small warn-text">일부 키워드 검색 실패: ${data.errors.map((e) => `${esc(e.keyword)} (${esc(e.message)})`).join(", ")}</p>` : "";
    $("#placesResults").innerHTML = (html || `<p class="empty">검색 결과가 없어요.</p>`) + errs;

    $$("#placesResults .place").forEach((el) => {
      const act = () => {
        const no = Number(el.dataset.no);
        state.placeHL = state.placeHL === no ? null : no;
        state.mapMode = "places";
        $$("#placesResults .place").forEach((x) => x.classList.toggle("hl", Number(x.dataset.no) === state.placeHL));
        renderMap(state.plan);
        if (state.placeHL && window.innerWidth <= 920) $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
      };
      el.addEventListener("click", (e) => { if (!e.target.closest("a")) act(); });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
    });
  }

  function renderPlacesMap() {
    const svg = $("#mapSvg");
    const groups = state.places.groups;
    const all = groups.flatMap((g) => g.places.map((p) => ({ ...p, color: g.color }))).filter((p) => p.hasCoord);
    const naverOn = isNaverReady();
    setMapEngine(naverOn);
    $("#mapNote").hidden = true;
    $("#mapBadge").textContent = naverOn ? "NAVER 지도 · 검색 결과" : "NAVER 검색 좌표 (WGS84)";
    const legend = () => {
      const missing = groups.flatMap((g) => g.places).length - all.length;
      $("#mapLegend").innerHTML = groups.map((g) => `<span><i style="background:${g.color}"></i>${esc(g.keyword)} ${g.places.length}곳</span>`).join("")
        + (missing ? `<span class="muted">좌표 없음 ${missing}곳 제외</span>` : "");
    };
    if (naverOn) {
      drawNaverMap({
        points: all.map((p) => ({ key: `p${p.no}`, lat: p.lat, lng: p.lng, label: p.no, color: p.color, title: `${p.no}. ${p.name}` })),
        highlight: state.placeHL ? `p${state.placeHL}` : null,
        onSelect: (key) => {
          state.placeHL = Number(key.slice(1));
          renderMap(state.plan);
          const el = $(`#placesResults .place[data-no="${state.placeHL}"]`);
          $$("#placesResults .place").forEach((x) => x.classList.toggle("hl", x === el));
          el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        },
      });
      return legend();
    }
    if (!all.length) return showMapEmpty("좌표가 있는 검색 결과가 없어요");
    const proj = makeProjector(all);
    // 강조된 핀은 맨 위에 그리기
    const ordered = [...all].sort((a, b) => (a.no === state.placeHL) - (b.no === state.placeHL));
    const pins = ordered.map((p) => {
      const [x, y] = proj(p);
      const hl = state.placeHL === p.no;
      return `<g class="marker pin ${hl ? "hl" : ""}" data-no="${p.no}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
        ${hl ? `<circle r="22" class="pulse" fill="${p.color}" />` : ""}
        <path d="M0 0 C-4 -6 -12 -11 -12 -19 A12 12 0 1 1 12 -19 C12 -11 4 -6 0 0Z" fill="${p.color}" stroke="#fff" stroke-width="2.5" transform="scale(${hl ? 1.2 : 1})" />
        <text text-anchor="middle" y="${hl ? -19.5 : -15.5}">${p.no}</text>
      </g>`;
    }).join("");
    svg.innerHTML = `${mapBackground()}${pins}`;

    const tip = $("#mapTooltip");
    $$(".pin", svg).forEach((g) => {
      const p = all.find((x) => x.no === Number(g.dataset.no));
      g.addEventListener("mouseenter", () => {
        tip.innerHTML = `<b>${p.no}. ${esc(p.name)}</b><span>${esc(p.category || "")}</span>`;
        const box = $("#map").getBoundingClientRect(), gb = g.getBoundingClientRect();
        tip.style.left = gb.left - box.left + gb.width / 2 + "px";
        tip.style.top = gb.top - box.top + "px";
        tip.hidden = false;
      });
      g.addEventListener("mouseleave", () => (tip.hidden = true));
      g.addEventListener("click", () => {
        state.placeHL = p.no;
        renderMap(state.plan);
        const el = $(`#placesResults .place[data-no="${p.no}"]`);
        $$("#placesResults .place").forEach((x) => x.classList.toggle("hl", x === el));
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
    const missing = groups.flatMap((g) => g.places).length - all.length;
    $("#mapLegend").innerHTML = groups.map((g) => `<span><i style="background:${g.color}"></i>${esc(g.keyword)} ${g.places.length}곳</span>`).join("")
      + (missing ? `<span class="muted">좌표 없음 ${missing}곳 제외</span>` : "");
  }

  function initPlaces() {
    $("#placesRegion").value = $("#region").value.trim();
    // 여행 지역 입력과 동기화
    const syncRegion = () => { $("#placesRegion").value = $("#region").value.trim(); };
    $("#region").addEventListener("input", syncRegion);
    $$("#regionQuick [data-region]").forEach((b) => b.addEventListener("click", syncRegion));
    renderPlaceChips();
    $$('input[name="pref"]').forEach((i) => i.addEventListener("change", () => { if (!chipsTouched) renderPlaceChips(); }));
    $("#placesChips").addEventListener("change", () => (chipsTouched = true));
    $("#placesForm").addEventListener("submit", (e) => { e.preventDefault(); runPlaceSearch(); });
    $$("#mapMode .tab").forEach((b) => b.addEventListener("click", () => {
      state.mapMode = b.dataset.mode;
      renderMap(state.plan);
    }));
  }

  /* ───────────── 자동차 경로 (NAVER Directions 5 · get_routes) ───────────── */
  async function runRoutes() {
    const plan = state.plan;
    if (!plan || state.routing) return;
    const info = $("#routeInfo"), btn = $("#routeBtn");
    if (location.protocol === "file:") {
      info.textContent = "서버(npm start)로 접속해야 경로를 계산할 수 있어요.";
      return;
    }
    state.routing = true;
    btn.disabled = true; btn.classList.add("loading");
    info.textContent = "NAVER 길찾기로 구간별 자동차 경로를 계산하는 중…";
    const legCount = plan.days.reduce((a, d) => a + Math.max(0, d.stops.length - 1), 0);
    const step = logger.step({ agent: "Tool", tool: "get_routes", icon: "🚗", title: `get_routes(${legCount}구간)`, text: "NAVER Directions 5 호출 중…" }, { scroll: false });

    try {
      const res = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: plan.days.map((d) => d.stops.map((s) => ({ name: s.name, lat: validCoord(s) ? s.lat : null, lng: validCoord(s) ? s.lng : null }))) }),
        signal: AbortSignal.timeout(30000),
      }).catch((e) => { throw new Error(e.name === "TimeoutError" ? "경로 계산 응답이 너무 늦어요." : "서버에 연결할 수 없어요."); });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.days) throw new Error(body?.error || `경로 계산 실패 (HTTP ${res.status})`);
      if (state.plan !== plan) return; // 그 사이 새 일정이 생성됨

      state.routes = body.days;
      const all = body.days.flatMap((d) => d.legs);
      const ok = all.filter((l) => l.status === "ok");
      const sum = (k) => ok.reduce((a, l) => a + (l[k] ?? 0), 0);
      state.routesSummary = {
        legs: all.length, ok: ok.length, unavailable: all.length - ok.length,
        distanceKm: Math.round(sum("distanceM") / 100) / 10, durationMin: Math.round(sum("durationMs") / 60000),
        tollFare: sum("tollFare"), fuelPrice: sum("fuelPrice"),
      };
      const r = state.routesSummary;
      info.textContent = `여행지 내 ${r.ok}/${r.legs}구간 · ${r.distanceKm}km · ${fmtMin(r.durationMin)}${r.unavailable ? ` · 확인 불가 ${r.unavailable}구간` : ""}`;
      renderItinerary(plan); renderBudget(plan);
      step.done({
        text: `${r.ok}/${r.legs}구간 경로 확인 · ${r.distanceKm}km · ${fmtMin(r.durationMin)} · 통행료 ${won(r.tollFare)} · 유류비 약 ${won(r.fuelPrice)}${r.unavailable ? ` · 확인 불가 ${r.unavailable}구간` : ""}`,
        warn: r.unavailable > 0,
        detail: { source: body.meta?.source, duration_ms: body.meta?.duration_ms, legs: all.map((l) => ({ from: l.from, to: l.to, status: l.status, km: l.distanceKm, min: l.durationMin, reason: l.reason })) },
      });
    } catch (err) {
      info.textContent = `경로 계산 실패: ${err.message}`;
      step.fail(err.message);
    } finally {
      state.routing = false;
      btn.disabled = false; btn.classList.remove("loading");
    }
  }

  /* ───────────── 시작 ───────────── */
  initForm();
  initPlaces();
  $("#errorRetry").addEventListener("click", generateWithAI);
  $("#errorClose").addEventListener("click", hideError);
  $("#routeBtn").addEventListener("click", runRoutes);
  const sample = buildSamplePlan(readInput());
  state.plan = sample;
  renderAll(sample);
  logger.renderStatic(buildSampleLog(sample));
  setupNaverMap();

  /** NAVER Web Dynamic Map 연결 — 실패하면 기존 미리보기(SVG) 지도를 그대로 사용 */
  async function setupNaverMap() {
    if (location.protocol === "file:") return;
    let keyId = null;
    try { keyId = (await (await fetch("/api/config")).json()).naverMapsKeyId; } catch { /* 서버 미실행 */ }
    const fallback = (reason) => {
      state.mapFallback = reason || naverFailReason();
      setMapEngine(false);
      if (state.plan) renderMap(state.plan);
    };
    const ok = await initNaverMap($("#naverMap"), keyId, { onFail: fallback });
    if (ok) { if (state.plan) renderMap(state.plan); }
    else fallback(naverFailReason());
  }
})();
