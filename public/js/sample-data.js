/**
 * 샘플 데이터 — 실제 API(장소 검색, 길찾기, 지도) 연결 전까지 사용합니다.
 * type: food | cafe | sight | nature | rest | shop | history | activity | lodging
 * cost: 1인 기준 비용(원), driveMin: 이전 장소에서 자동차 이동 시간(분)
 */
window.SAMPLE_DATA = {
  강릉: {
    name: "강릉",
    aliases: ["강릉", "강원", "속초", "양양", "정동진", "동해"],
    emoji: "🌊",
    tagline: "바다와 커피, 순두부가 있는 동해 드라이브",
    distanceKm: 230, tollWon: 15600, lodgingPerNight: 140000,
    lodgingName: "경포 오션뷰 호텔",
    weather: ["맑음 · 8°C", "구름 조금 · 6°C", "맑음 · 9°C", "흐림 · 7°C", "맑음 · 10°C"],
    days: [
      { title: "동해 바다와 첫 인사", stops: [
        { time: "12:30", name: "초당순두부마을", type: "food", cost: 13000, lat: 37.7905, lng: 128.9150, driveMin: 160, desc: "짬뽕순두부로 든든하게 시작. 마을 공영주차장 이용." },
        { time: "14:00", name: "경포호 둘레길", type: "nature", cost: 0, lat: 37.7955, lng: 128.9020, driveMin: 7, desc: "호수 한 바퀴 가볍게 산책 (약 40분)." },
        { time: "15:30", name: "안목해변 커피거리", type: "cafe", cost: 9000, lat: 37.7720, lng: 128.9475, driveMin: 15, desc: "바다가 보이는 2층 창가 자리 추천!" },
        { time: "18:30", name: "강릉중앙시장", type: "shop", cost: 18000, lat: 37.7545, lng: 128.8990, driveMin: 14, desc: "닭강정·감자전 먹방 & 기념품 쇼핑." },
        { time: "20:30", name: "경포 오션뷰 호텔 체크인", type: "lodging", cost: 0, lat: 37.8020, lng: 128.9060, driveMin: 15, desc: "무료 주차 · 오션뷰 객실." }
      ]},
      { title: "정동진 해안 드라이브", stops: [
        { time: "09:30", name: "정동진 해변", type: "nature", cost: 0, lat: 37.6910, lng: 129.0340, driveMin: 30, desc: "헌화로 해안도로를 따라 드라이브." },
        { time: "11:00", name: "하슬라아트월드", type: "sight", cost: 15000, lat: 37.7070, lng: 129.0110, driveMin: 8, desc: "바다 위 미술관 & 조각공원." },
        { time: "13:00", name: "사천진 물회거리", type: "food", cost: 20000, lat: 37.8430, lng: 128.8740, driveMin: 35, desc: "시원한 물회 한 그릇." },
        { time: "15:00", name: "오죽헌", type: "history", cost: 3000, lat: 37.7790, lng: 128.8780, driveMin: 15, desc: "율곡 이이 생가, 검은 대나무 숲." },
        { time: "17:00", name: "호텔에서 휴식", type: "rest", cost: 0, lat: 37.8020, lng: 128.9060, driveMin: 12, desc: "노을 보며 여유롭게 쉬기." }
      ]},
      { title: "항구 시장 들렀다 귀가", stops: [
        { time: "10:00", name: "주문진수산시장", type: "food", cost: 25000, lat: 37.8930, lng: 128.8270, driveMin: 20, desc: "대게·회 포장 또는 시장 식당 브런치." },
        { time: "12:00", name: "주문진 영진해변 (BTS 정류장)", type: "sight", cost: 0, lat: 37.8890, lng: 128.8290, driveMin: 5, desc: "포토 스팟에서 기념사진." },
        { time: "13:00", name: "보헤미안 박이추 커피", type: "cafe", cost: 9000, lat: 37.9030, lng: 128.8220, driveMin: 6, desc: "핸드드립 1세대 바리스타의 커피." },
        { time: "14:00", name: "서울로 출발", type: "rest", cost: 0, lat: 37.9030, lng: 128.8220, driveMin: 0, desc: "주말 오후 정체 대비 일찍 출발해요." }
      ]}
    ],
    extras: [
      { time: "10:00", name: "강문해변 브런치", type: "cafe", cost: 16000, lat: 37.7950, lng: 128.9190, driveMin: 6, desc: "느지막이 일어나 바다 앞 브런치." },
      { time: "13:00", name: "대관령 양떼목장", type: "nature", cost: 7000, lat: 37.6880, lng: 128.7520, driveMin: 30, desc: "탁 트인 초원 산책." },
      { time: "17:00", name: "숙소 스파 & 휴식", type: "rest", cost: 0, lat: 37.8020, lng: 128.9060, driveMin: 30, desc: "자유 시간." }
    ]
  },

  제주: {
    name: "제주",
    aliases: ["제주", "서귀포", "애월", "성산"],
    emoji: "🍊",
    tagline: "렌터카로 한 바퀴, 오름과 바다의 섬",
    distanceKm: 0, tollWon: 0, lodgingPerNight: 160000, flightPerPerson: 110000,
    lodgingName: "애월 감성 독채",
    weather: ["맑음 · 14°C", "바람 강함 · 12°C", "구름 많음 · 13°C", "맑음 · 15°C", "비 · 11°C"],
    days: [
      { title: "서쪽 바다 따라 애월로", stops: [
        { time: "11:00", name: "제주공항 렌터카 인수", type: "rest", cost: 0, lat: 33.5066, lng: 126.4929, driveMin: 0, desc: "공항 셔틀로 렌터카 하우스 이동." },
        { time: "12:30", name: "고기국수 골목", type: "food", cost: 10000, lat: 33.5000, lng: 126.5300, driveMin: 15, desc: "진한 돼지뼈 육수 고기국수." },
        { time: "14:30", name: "애월 한담해안산책로", type: "nature", cost: 0, lat: 33.4630, lng: 126.3100, driveMin: 30, desc: "에메랄드빛 바다 옆 산책." },
        { time: "16:00", name: "애월 오션뷰 카페", type: "cafe", cost: 9000, lat: 33.4600, lng: 126.3150, driveMin: 3, desc: "통창 너머 노을 맛집." },
        { time: "19:00", name: "흑돼지 거리", type: "food", cost: 30000, lat: 33.5130, lng: 126.5250, driveMin: 30, desc: "근고기 두툼하게 한 판." }
      ]},
      { title: "동쪽 일출과 숲", stops: [
        { time: "08:30", name: "성산일출봉", type: "nature", cost: 5000, lat: 33.4580, lng: 126.9420, driveMin: 70, desc: "아침 일찍 올라야 덜 붐벼요." },
        { time: "10:30", name: "섭지코지", type: "sight", cost: 0, lat: 33.4240, lng: 126.9300, driveMin: 10, desc: "해안 절벽 산책로." },
        { time: "12:30", name: "해녀의 집 전복죽", type: "food", cost: 15000, lat: 33.4600, lng: 126.9350, driveMin: 10, desc: "전복죽 & 해산물." },
        { time: "14:30", name: "비자림", type: "nature", cost: 3000, lat: 33.4900, lng: 126.8100, driveMin: 25, desc: "천년의 숲 피톤치드 산책." },
        { time: "16:30", name: "월정리 해변", type: "cafe", cost: 8000, lat: 33.5560, lng: 126.7960, driveMin: 15, desc: "해변 카페에서 쉬어가기." }
      ]},
      { title: "남쪽 서귀포와 귀가", stops: [
        { time: "10:00", name: "천지연폭포", type: "nature", cost: 2000, lat: 33.2470, lng: 126.5540, driveMin: 60, desc: "평탄한 산책로라 부모님과도 OK." },
        { time: "11:30", name: "서귀포 매일올레시장", type: "shop", cost: 20000, lat: 33.2500, lng: 126.5630, driveMin: 5, desc: "감귤·오메기떡 기념품 쇼핑." },
        { time: "13:30", name: "카멜리아힐", type: "sight", cost: 10000, lat: 33.2900, lng: 126.3700, driveMin: 30, desc: "동백 시즌 포토 스팟." },
        { time: "16:30", name: "렌터카 반납 & 공항", type: "rest", cost: 0, lat: 33.5066, lng: 126.4929, driveMin: 50, desc: "반납 시간 여유 있게!" }
      ]}
    ],
    extras: [
      { time: "10:00", name: "협재해변", type: "nature", cost: 0, lat: 33.3940, lng: 126.2390, driveMin: 20, desc: "비양도가 보이는 맑은 바다." },
      { time: "12:30", name: "한림 보말칼국수", type: "food", cost: 12000, lat: 33.4100, lng: 126.2650, driveMin: 8, desc: "현지인 맛집." },
      { time: "15:00", name: "숙소 휴식 & 산책", type: "rest", cost: 0, lat: 33.4630, lng: 126.3300, driveMin: 15, desc: "자유 시간." }
    ]
  },

  경주: {
    name: "경주",
    aliases: ["경주", "경북", "포항", "울산"],
    emoji: "🏯",
    tagline: "천년 고도의 낮과 밤, 황리단길 산책",
    distanceKm: 340, tollWon: 19800, lodgingPerNight: 120000,
    lodgingName: "보문 한옥 스테이",
    weather: ["맑음 · 11°C", "맑음 · 12°C", "구름 조금 · 10°C", "맑음 · 13°C", "흐림 · 9°C"],
    days: [
      { title: "황리단길과 신라의 밤", stops: [
        { time: "13:00", name: "황리단길 한식 밥집", type: "food", cost: 15000, lat: 35.8370, lng: 129.2100, driveMin: 240, desc: "쌈밥 정식. 근처 공영주차장 이용." },
        { time: "14:30", name: "대릉원", type: "history", cost: 3000, lat: 35.8380, lng: 129.2120, driveMin: 3, desc: "고분 사이 산책 & 천마총." },
        { time: "16:00", name: "황리단길 카페 거리", type: "cafe", cost: 8000, lat: 35.8360, lng: 129.2085, driveMin: 2, desc: "한옥 카페에서 휴식." },
        { time: "17:30", name: "첨성대", type: "history", cost: 0, lat: 35.8347, lng: 129.2190, driveMin: 5, desc: "노을 질 때 가장 예뻐요." },
        { time: "19:00", name: "동궁과 월지 야경", type: "sight", cost: 3000, lat: 35.8345, lng: 129.2265, driveMin: 5, desc: "연못에 비친 야경 필수 코스." }
      ]},
      { title: "불국사와 보문호", stops: [
        { time: "09:30", name: "불국사", type: "history", cost: 6000, lat: 35.7900, lng: 129.3320, driveMin: 20, desc: "아침 일찍 방문하면 한적해요." },
        { time: "11:00", name: "석굴암", type: "history", cost: 6000, lat: 35.7950, lng: 129.3490, driveMin: 15, desc: "토함산 산길 드라이브." },
        { time: "13:00", name: "보문 순두부 & 한정식", type: "food", cost: 15000, lat: 35.8400, lng: 129.2900, driveMin: 20, desc: "든든한 점심." },
        { time: "14:30", name: "보문호 둘레길", type: "nature", cost: 0, lat: 35.8430, lng: 129.2860, driveMin: 5, desc: "호숫가 산책 & 자전거." },
        { time: "16:30", name: "경주월드", type: "activity", cost: 45000, lat: 35.8360, lng: 129.2830, driveMin: 5, desc: "스릴 원하면 추가! (선택)" }
      ]},
      { title: "동해 바다 보고 귀가", stops: [
        { time: "10:00", name: "문무대왕릉 (감포)", type: "nature", cost: 0, lat: 35.7390, lng: 129.4870, driveMin: 35, desc: "바다 위 왕릉과 갈매기." },
        { time: "11:30", name: "감포 해국길 카페", type: "cafe", cost: 9000, lat: 35.8040, lng: 129.5040, driveMin: 15, desc: "어촌 골목 벽화 산책." },
        { time: "13:00", name: "경주 교촌마을", type: "shop", cost: 15000, lat: 35.8300, lng: 129.2150, driveMin: 40, desc: "교동법주·찰보리빵 기념품." },
        { time: "14:30", name: "서울로 출발", type: "rest", cost: 0, lat: 35.8300, lng: 129.2150, driveMin: 0, desc: "중간 휴게소에서 쉬어가기." }
      ]}
    ],
    extras: [
      { time: "10:00", name: "양동마을", type: "history", cost: 4000, lat: 35.9990, lng: 129.2570, driveMin: 30, desc: "유네스코 세계유산 전통마을." },
      { time: "13:00", name: "안압지 근처 떡갈비", type: "food", cost: 16000, lat: 35.8350, lng: 129.2240, driveMin: 30, desc: "점심." },
      { time: "15:00", name: "한옥 숙소에서 휴식", type: "rest", cost: 0, lat: 35.8420, lng: 129.2950, driveMin: 15, desc: "자유 시간." }
    ]
  }
};

window.TYPE_META = {
  food:     { label: "맛집",   pref: "맛집",   icon: "🍜", color: "#f2734f" },
  cafe:     { label: "카페",   pref: "카페",   icon: "☕", color: "#b07a4f" },
  sight:    { label: "관광",   pref: "관광",   icon: "📸", color: "#5b7cfa" },
  nature:   { label: "자연",   pref: "자연",   icon: "🌿", color: "#2fa37a" },
  rest:     { label: "휴식",   pref: "휴식",   icon: "🛌", color: "#8a8fa3" },
  shop:     { label: "쇼핑",   pref: "쇼핑",   icon: "🛍️", color: "#d65db1" },
  history:  { label: "역사",   pref: "역사",   icon: "🏛️", color: "#9a6bd8" },
  activity: { label: "액티비티", pref: "액티비티", icon: "🏄", color: "#ef9a1a" },
  lodging:  { label: "숙소",   pref: "휴식",   icon: "🏨", color: "#3d8bd9" }
};

window.DAY_COLORS = ["#ff6b4a", "#2fa37a", "#5b7cfa", "#ef9a1a", "#d65db1"];
