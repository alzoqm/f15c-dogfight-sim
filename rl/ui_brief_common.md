# UI 대개편 — 공통 브리프 (UI 워커 필독, 그래픽 공통 브리프 rl/gfx_brief_common.md 의 1·2·7 규칙도 적용)

사용자 평가: "UI 가 너무 AI 티가 난다. 너무 단순하지도, 너무 난잡하지도 않게 대대적으로 수정."

## "AI 티" 로 보이는 것 (피할 것)
- 어두운 반투명 유리 카드(glassmorphism) + 둥근 모서리 + 형광 초록/청록 강조색의 남발
- 모든 것을 같은 크기의 둥근 박스에 담기, 의미 없는 그라데이션·글로우·이모지
- 정보 위계 없이 설명 문장과 표를 한 화면에 다 쏟아내기 (현재 메뉴에 조작표 전체가 펼쳐져 있음)
- 시스템 기본 폰트, 기본 체크박스·라디오·select 그대로

## 지향점
- 실제 군용 항공전자/항공우주 제품의 절제된 디자인: 단단한 그리드, 얇은 선(1px 헤어라인), 모서리 각짐(반경 0~2px),
  색은 중성 톤 2~3개 + 강조색 1개(예: 앰버 #e8a33d 또는 신호 주황) 만, 강조색은 "선택됨/주요 동작"에만.
- 타이포 위계: 큰 제목 1, 섹션 라벨(작은 대문자/자간 넓힘), 본문, 수치(고정폭). 한글은 'Pretendard' 또는 'IBM Plex Sans KR',
  숫자·라벨은 'IBM Plex Mono' / 'JetBrains Mono' — Google Fonts 또는 jsdelivr CDN 으로 불러와도 된다 (오프라인 폴백 폰트 지정).
- 정보는 단계적으로: 핵심(시작, 난이도, 조작 방식, 품질) 은 한눈에, 상세(조작표·옵션 설명)는 탭/접힘/별도 패널로.
- 상태 변화(hover/focus/선택)는 명확하지만 과하지 않게. 키보드 포커스 표시 유지.
- 반응형: 1280×720 ~ 2560×1440 에서 어색하지 않게, 좁은 창(800px)에서도 깨지지 않게.

## 반드시 지킬 것
- JS 가 쓰는 DOM id 는 전부 유지 (목록: bfm-wpn btn-end-menu btn-end-restart btn-help-close btn-keybind btn-menu btn-restart btn-resume
  damage-flash end end-reason end-stats end-title help hud kb-close kb-invert kb-mflight kb-msg kb-preset kb-recenter kb-recenter-val
  kb-sens kb-sens-val kb-table kb-throttle kb-xaxis kb-ysens kb-ysens-val keybind keys-custom load-bar load-text loading menu opt-ammo
  opt-cas opt-fuel opt-g opt-invert opt-quality opt-sens opt-sound pause sens-val view, 그리고 name 속성 라디오 그룹·class 로 JS 가
  찾는 요소). 작업 전 src/main.js, src/keybind.js, src/game.js 에서 querySelector/getElementById/classList/name= 사용처를 grep 하라.
- 기능·텍스트 의미는 유지(문구 다듬기는 가능, 한국어).
