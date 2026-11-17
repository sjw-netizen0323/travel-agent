/**
 * calculate_budget — 외부 API 없이 동작하는 순수 JavaScript 예산 계산기
 * (브라우저와 Node.js 양쪽에서 같은 코드를 사용합니다)
 *
 * 항목 상태(status)
 *  - "confirmed" 확인됨 : API 등 출처가 있는 실제 금액 (예: NAVER 길찾기 통행료)
 *  - "estimated" 추정치 : AI·평균 단가 등으로 추정한 금액 → 합계에는 포함하되 구분 표시
 *  - "unknown"   미확인 : 금액을 알 수 없음 → 합계에서 제외하고 개수만 셈
 * status를 주지 않으면 금액이 있을 때 "estimated", 없으면 "unknown"으로 봅니다. (확인되지 않은 값을 확정으로 취급하지 않음)
 */

export const BUDGET_CATEGORIES = {
  transport:   { label: "교통비",   icon: "🚗" },
  lodging:     { label: "숙박비",   icon: "🏨" },
  food:        { label: "식비",     icon: "🍜" },
  sightseeing: { label: "관광비",   icon: "🎟️" },
  shopping:    { label: "카페·쇼핑", icon: "☕" },
  etc:         { label: "기타",     icon: "🧾" },
  reserve:     { label: "예비비",   icon: "🧷" },
};

export const STATUS_LABELS = { confirmed: "확인됨", estimated: "추정치", unknown: "미확인" };

/**
 * @param {object} input
 * @param {number} input.totalBudget  사용자 총예산(원)
 * @param {number} [input.people=1]   인원 (unit: "perPerson" 항목에 곱함)
 * @param {Array<{category:string,label:string,amount?:number|null,unit?:"total"|"perPerson",quantity?:number,status?:string,source?:string}>} input.items
 * @param {string[]} [input.required]  꼭 있어야 하는 카테고리. 항목이 없으면 "미확인"으로 추가 (예: ["transport","lodging","food"])
 * @param {number} [input.tightRatio=0.9]  예산 대비 이 비율 이상이면 "빠듯함"
 */
export function calculateBudget({ totalBudget, people = 1, items = [], required = [], tightRatio = 0.9 } = {}) {
  if (!Number.isFinite(totalBudget) || totalBudget < 0) throw new TypeError("totalBudget은 0 이상의 숫자여야 해요.");
  if (!Number.isInteger(people) || people < 1) throw new TypeError("people은 1 이상의 정수여야 해요.");
  if (!Array.isArray(items)) throw new TypeError("items는 배열이어야 해요.");

  const normalized = items.map((it, i) => normalizeItem(it, i, people));

  // 필수 카테고리가 비어 있으면 "미확인" 항목 추가 (빠진 비용을 0원으로 착각하지 않도록)
  for (const cat of required) {
    if (!normalized.some((it) => it.category === cat)) {
      normalized.push(normalizeItem({ category: cat, label: `${BUDGET_CATEGORIES[cat]?.label ?? cat} (정보 없음)`, amount: null, status: "unknown", source: "calculate_budget" }, normalized.length, people));
    }
  }

  const categories = Object.keys(BUDGET_CATEGORIES)
    .concat([...new Set(normalized.map((it) => it.category))].filter((c) => !BUDGET_CATEGORIES[c]))
    .map((key) => {
      const list = normalized.filter((it) => it.category === key);
      if (!list.length) return null;
      const confirmed = sumBy(list, "confirmed"), estimated = sumBy(list, "estimated");
      return {
        key,
        label: BUDGET_CATEGORIES[key]?.label ?? key,
        icon: BUDGET_CATEGORIES[key]?.icon ?? "🧾",
        confirmed, estimated,
        total: confirmed + estimated,
        unknownCount: list.filter((it) => it.status === "unknown").length,
        items: list,
      };
    })
    .filter(Boolean);

  const confirmed = sumBy(normalized, "confirmed");
  const estimated = sumBy(normalized, "estimated");
  const known = confirmed + estimated;
  const unknownCount = normalized.filter((it) => it.status === "unknown").length;
  const remaining = totalBudget - known;
  const usageRate = totalBudget > 0 ? known / totalBudget : null;

  let status;
  if (totalBudget === 0) status = "no_budget";
  else if (remaining < 0) status = "over";
  else if (usageRate >= tightRatio) status = "tight";
  else status = "within";

  const warnings = [];
  if (status === "over") warnings.push(`총예산을 ${fmt(-remaining)} 초과해요.`);
  if (status === "tight") warnings.push(`예산의 ${Math.round(usageRate * 100)}%를 사용해 여유가 적어요.`);
  if (unknownCount) warnings.push(`금액을 확인할 수 없는 항목 ${unknownCount}개는 합계에서 빠져 있어, 실제 비용은 더 늘어날 수 있어요.`);
  if (estimated > 0) warnings.push(`합계 중 ${fmt(estimated)}은 추정치예요. 예약 시점에 실제 가격을 확인해 주세요.`);

  return {
    totalBudget,
    people,
    items: normalized,
    categories,
    totals: { confirmed, estimated, known, unknownCount },
    remaining,
    remainingConfirmedOnly: totalBudget - confirmed,
    usageRate,
    perPerson: Math.round(known / people),
    status,
    statusLabel: { within: "예산 내", tight: "빠듯함", over: "예산 초과", no_budget: "예산 미입력" }[status],
    warnings,
  };
}

function normalizeItem(it, index, people) {
  if (!it || typeof it !== "object") throw new TypeError(`items[${index}]가 객체가 아니에요.`);
  const raw = it.amount;
  const hasAmount = raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw));
  const amount = hasAmount ? Number(raw) : null;
  if (amount !== null && amount < 0) throw new TypeError(`items[${index}] 금액이 음수예요: ${raw}`);
  const quantity = it.quantity === undefined ? 1 : Number(it.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) throw new TypeError(`items[${index}] 수량이 올바르지 않아요.`);
  const unit = it.unit === "perPerson" ? "perPerson" : "total";

  // 금액이 없으면 무조건 미확인, status가 없으면 추정치로 간주
  let status = it.status;
  if (amount === null) status = "unknown";
  else if (!["confirmed", "estimated", "unknown"].includes(status)) status = "estimated";

  const total = status === "unknown" ? null : Math.round(amount * quantity * (unit === "perPerson" ? people : 1));
  return {
    category: it.category || "etc",
    label: it.label || BUDGET_CATEGORIES[it.category]?.label || "항목",
    amount, unit, quantity, total,
    status,
    statusLabel: STATUS_LABELS[status],
    source: it.source || null,
  };
}

const sumBy = (list, status) => list.filter((it) => it.status === status).reduce((a, it) => a + it.total, 0);
const fmt = (n) => Math.round(n).toLocaleString("ko-KR") + "원";
