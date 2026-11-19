# 그래픽 대개편 — 공통 브리프 (모든 워커 필독)

프로젝트: `C:\Users\USER\Downloads\work5` — three.js r170 (CDN importmap, 빌드 없음, ES 모듈) 로 만든 F-15C 1:1 공중전 시뮬레이터.
실행: `python server.py` 가 이미 http://localhost:8615/ 에서 떠 있다. 브라우저 확인은 PM(Claude)이 한다.
원본 백업: `rl/gfx_backup_20261119/` (되돌릴 때 참고).

목표: 지금 그래픽이 "너무 구리다"는 사용자 평가. 텍스처·환경·효과·모델 형상(폴리곤)을 **대대적으로** 개선해
현대 비행 게임(예: DCS/Ace Combat 수준을 지향) 느낌의 사실적 그래픽으로 만든다.

## 반드시 지킬 규칙
1. **자기 담당 파일만 수정한다.** 다른 워커가 동시에 다른 파일을 고치고 있다. 담당 외 파일은 읽기만.
2. **외부 공개 API(export 이름, 함수 시그니처, 반환 객체의 필드/메서드, userData.update 등)는 유지한다.**
   다른 모듈(game.js, main.js, weapons.js)이 쓰는 것을 grep 으로 확인하고 깨뜨리지 말 것.
3. 외부 이미지/모델 파일 다운로드 금지. 텍스처는 **절차적 생성**(Canvas 2D, DataTexture, 셰이더 노이즈)으로 만든다.
   three.js 애드온은 `three/addons/...` 경로로 import 가능 (r170 examples/jsm).
4. 성능: 품질 '중간'(main.js QUALITY.medium)에서 일반 노트북 GPU 60fps 목표. 무거운 기능은 품질 단계(low/medium/high/ultra)에
   따라 줄일 수 있게. 드로우콜·폴리곤 예산을 의식할 것 (예: 기체 1대 ≤ 약 15만 삼각형, 인스턴싱 적극 사용).
5. 물리·게임플레이·AI 코드는 건드리지 않는다. 충돌/고도 함수(`world.heightAt`, `terrainHeight`, `isWater`)의 결과값은 바꾸지 않는다.
6. 렌더러: ACESFilmic 톤매핑, `logarithmicDepthBuffer: true`, PCFSoft 그림자, EffectComposer + UnrealBloom 사용 중.
   **scene.environment(반사용 환경맵)은 렌더링 파이프라인 담당(main.js)이 하늘에서 PMREM 으로 만들어 넣는다.**
   재질은 MeshStandardMaterial/MeshPhysicalMaterial 로 만들고 envMap 을 직접 지정하지 말고 scene.environment 를 쓰게 둘 것.
7. 코드 주석은 기존처럼 한국어. 한국어 문장에 한자(漢字)를 섞지 말 것.
8. 끝나면 `node -e "import('file:///C:/Users/USER/Downloads/work5/src/<파일>.js').catch(e=>{console.error(e.message);process.exit(1)})"`
   같은 방식은 three CDN import 때문에 실패할 수 있으니, 최소한 문법 검사로
   `node --check` 대신 `node -e "new (require('vm').SourceTextModule||Function)"` 같은 꼼수 말고,
   `npx --yes acorn --ecma2022 --module src/<파일>.js > NUL` 로 파싱 검사를 할 것 (acorn 설치 안 되면 생략하고 보고).
9. 최종 보고(한국어, 짧게): 바꾼 것 목록, 새로 생긴/바뀐 공개 API(있다면), 성능상 주의점, 확인하지 못한 것.
