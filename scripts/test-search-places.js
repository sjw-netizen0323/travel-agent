// 실제 NAVER API HUB 호출 테스트: npm run test:search -- [지역] [키워드...]
// 예) npm run test:search -- 강릉 맛집 카페 관광지
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { searchPlaces } from "../lib/searchPlaces.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const [region = "강릉", ...rest] = process.argv.slice(2);
const keywords = rest.length ? rest : ["관광지", "맛집", "카페"];
const inKorea = (p) => p.lat >= 33 && p.lat <= 39 && p.lng >= 124 && p.lng <= 132;

let failed = 0;
console.log(`🔎 search_places 실제 호출 테스트 — 지역: ${region}, 키워드: ${keywords.join(", ")}\n`);

for (const keyword of keywords) {
  const t = Date.now();
  try {
    const { query, total, places } = await searchPlaces({ region, keyword });
    console.log(`■ "${query}" — 총 ${total.toLocaleString()}건 중 ${places.length}건 (${Date.now() - t}ms)`);
    for (const p of places) {
      console.log(`  - ${p.name} [${p.category || "카테고리 없음"}]`);
      console.log(`    ${p.roadAddress || p.address || "(주소 없음)"}`);
      console.log(`    좌표: ${p.hasCoord ? `${p.lat}, ${p.lng}` : "(없음)"}${p.link ? `  ·  ${p.link}` : ""}`);
    }
    const checks = [
      ["결과 1건 이상", places.length > 0],
      ["모든 결과에 이름 있음", places.every((p) => p.name)],
      ["모든 결과에 주소 있음", places.every((p) => p.roadAddress || p.address)],
      ["모든 좌표가 한국 범위(WGS84)", places.every((p) => p.hasCoord && inKorea(p))],
      ["이름에 HTML 태그 없음", places.every((p) => !/[<>]/.test(p.name))],
    ];
    for (const [label, ok] of checks) { console.log(`    ${ok ? "✅" : "❌"} ${label}`); if (!ok) failed++; }
    console.log();
  } catch (err) {
    failed++;
    console.log(`■ "${region} ${keyword}" — ❌ ${err.message} (status=${err.status ?? "-"}, code=${err.code ?? "-"})\n`);
  }
}

console.log(failed ? `❌ 실패 ${failed}건` : "✅ 모든 검사 통과");
process.exit(failed ? 1 : 0);
