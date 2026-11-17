# 여행 플래너 (국내 자동차 여행)

Express 서버 + OpenAI Responses API로 여행 일정을 생성하는 웹 앱입니다.

## 실행

```bash
npm install
npm start
```

브라우저에서 http://localhost:3000 으로 접속하세요. (index.html을 파일로 직접 열면 API를 호출할 수 없어요)

## 환경 변수 (.env)

| 이름 | 설명 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI API Key (서버에서만 사용, 브라우저에 전달되지 않음) |
| `OPENAI_MODEL` | 사용할 모델. 예: `gpt-5-mini` |
| `PORT` | (선택) 서버 포트, 기본 3000 |

## 구조

```
server.js          Express 서버 · POST /api/plan · GET /api/health
public/            브라우저에 제공되는 정적 파일 (이 폴더만 공개)
  index.html
  css/style.css
  js/app.js        폼 입력 → /api/plan 호출 → 일정/지도/예산/실행 기록 렌더링
  js/sample-data.js  첫 화면 미리보기용 샘플 데이터
```

## API

`POST /api/plan` — 요청 본문:

```json
{ "region": "강릉", "startDate": "2026-12-04", "duration": 3, "people": 2, "budget": 800000,
  "prefs": ["맛집", "자연"], "transport": "own", "origin": "서울", "parking": true, "toll": true, "notes": "" }
```

응답: `{ plan, meta }` — `plan`은 Structured Outputs(JSON Schema)로 형식이 고정된 일정, `meta`는 모델명·소요 시간·토큰 사용량입니다.
오류 시 `{ error, code }`와 HTTP 상태 코드를 돌려줍니다.

현재 단계에서는 Function Calling / 외부 검색을 사용하지 않으므로 장소 좌표·가격·운영 정보는 AI의 추정치입니다.

## 장소 검색 (NAVER API HUB 지역 검색)

`lib/searchPlaces.js`의 `searchPlaces()`(= search_places)가 `GET https://naverapihub.apigw.ntruss.com/search/v1/local`을 호출합니다.

- 인증 헤더: `X-NCP-APIGW-API-KEY-ID` / `X-NCP-APIGW-API-KEY` ← `.env`의 `NAVER_API_HUB_CLIENT_ID` / `NAVER_API_HUB_CLIENT_SECRET`
- 검색어: `"{여행 지역} {키워드}"`, 키워드당 최대 5건 (API 제한)
- 추출 필드: 장소명(title, HTML 태그 제거) · 지번/도로명 주소 · 카테고리 · 좌표 · 링크 · 설명
- 좌표: `mapx`=경도, `mapy`=위도 (WGS84). 실제 응답은 `"1289129968"`처럼 **도 × 10^7 정수 문자열**이라 10^7로 나눠 사용 (소수 형식도 처리)
- 영업시간·평점·가격은 API가 제공하지 않으므로 표시하지 않습니다.

서버 엔드포인트: `GET /api/places?region=강릉&keywords=맛집,카페`

```bash
npm test                                   # 오프라인 단위 테스트 (가짜 응답)
npm run test:search -- 강릉 관광지 맛집 카페  # 실제 API 호출 테스트
```

## get_routes (NAVER Maps Directions 5)

`lib/getRoutes.js` — `getRoute(from, to)` / `getRoutes(stops)`

- `GET https://maps.apigw.ntruss.com/map-direction/v1/driving`, 헤더 `x-ncp-apigw-api-key-id` / `x-ncp-apigw-api-key` ← `.env`의 `NAVER_MAPS_CLIENT_ID` / `NAVER_MAPS_CLIENT_SECRET`
- 좌표는 `start` / `goal` = **`경도,위도`** (WGS84, 지역 검색 결과 좌표 그대로)
- 결과: 거리(m→km), 시간(ms→분), 통행료(`tollFare`), 유류비 추정(`fuelPrice`)
- 경로 없음(code 1~5)·좌표 없음은 **"확인 불가"** 로 반환 (실제 오류 응답은 `{"error":{"code":2,...}}` 형태). 도보·대중교통 경로는 만들지 않음
- 서버 엔드포인트: `POST /api/routes` `{ days: [[{name,lat,lng}, ...], ...] }` — AI 일정 생성 후 자동 실행, "NAVER 자동차 경로 계산" 버튼으로도 실행

## calculate_budget (외부 API 없음)

`public/js/calculateBudget.js` — 브라우저와 Node에서 같은 코드 사용

- 교통비·숙박비·식비·관광비·카페/쇼핑·기타·예비비 카테고리별 합산, 총예산 대비 잔여 예산·사용률·상태(예산 내/빠듯함/초과)
- 항목 상태: **확인됨**(출처 있는 금액) / **추정치**(AI·평균 단가, 합계 포함) / **미확인**(금액 없음, 합계 제외 + 경고)
- status가 없으면 추정치로, 금액이 없으면 미확인으로 처리. 필수 카테고리가 비어 있으면 미확인 항목 추가

```bash
npm run test:tools   # get_routes 실제 호출 + calculate_budget 실행
```

## AI Agent (Function Calling)

`lib/agent.js` — `runTravelAgent()` / `POST /api/plan` (NDJSON 스트리밍)

- Responses API에 함수 Tool `search_places` · `get_routes` · `calculate_budget`(strict 스키마)와 내장 `web_search`를 등록하고 `tool_choice: "auto"` — **LLM이 필요한 Tool만 선택**합니다. 순서 강제 없음
- Agent Loop: 모델 호출 → `function_call`을 Node.js에서 실제 실행 → `function_call_output`으로 결과 전달 → 반복 → 최종 JSON(Structured Outputs)
- 한도: 최대 10턴 · Tool 24회 · 턴당 8회 · 150초. 넘으면 `tool_choice: "none"`으로 최종 답변만 요청
- 오류: Tool 실행 오류는 `{error}`로 LLM에 전달(대안 판단), OpenAI API 오류는 사용자 메시지로 변환
- 근거 검증(`verifyPlan`): 이동시간은 get_routes 결과, 좌표는 search_places 결과, 가격은 web_search 사용 시에만 인정. 근거 없는 값은 null(미확인)로 바꾸고 Trace에 개수 표시
- Agent Trace: LLM 호출별 선택한 Tool, 실제 호출된 Tool 이름·인자·결과 요약, web_search 검색어를 실시간 표시
- `.env`에 `AGENT_WEB_SEARCH=off`를 넣으면 web_search를 끌 수 있습니다

```bash
npm run test:agent -- 강릉 "오죽헌은 꼭 가고 싶어요"   # 실제 OpenAI + NAVER로 Agent 실행 (토큰 비용 발생)
```

## 결과 화면 (Level 1)

- **날짜별 일정 탭**: 장소명 · 방문 시간 · 추천 이유 · NAVER 주소 · 이동시간(get_routes 결과만, 없으면 "미확인")
- **NAVER Maps Web Dynamic Map** (`public/js/naverMap.js`): `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=…`
  - Client ID는 `GET /api/config`로 받음 (Secret은 서버에만)
  - 좌표가 확인된 장소에 날짜별 색 마커, **get_routes로 실제 계산된 구간만** 도로 모양 그대로 경로선 표시
  - 인증 실패(`navermap_authFailure`)·로드 실패 시 기존 미리보기(SVG) 지도로 자동 대체하고 이유를 표시
  - ⚠️ NCP 콘솔 → Maps Application에서 **Dynamic Map 사용 체크**와 **Web 서비스 URL에 `http://localhost:3000` 등록**이 필요합니다
- **예산 표**: 항목 · 근거(확인됨/추정치/미확인 + 출처) · 금액 · 비율, 하단에 합계 · 미확인 건수 · 총예산 · 잔여 예산
- **출처 패널**: NAVER 지역 검색어, Directions 구간 수, 웹 검색어와 출처 링크, 사용 모델
- **Agent Trace**: Tool별 호출 횟수 버튼으로 필터링 (search_places · get_routes · calculate_budget · web_search · LLM 호출)
