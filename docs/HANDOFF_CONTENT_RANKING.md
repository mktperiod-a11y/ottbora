# 콘텐츠 랭킹 파이프라인 핸드오프

브랜치: `feat/content-ranking-pipeline`

## 목표

콘텐츠ZONE의 영화/드라마/예능/애니 탭을 가능한 범위에서 자동 갱신하고, 외부 데이터 소스가 실패해도 빈 탭이 되지 않도록 fallback을 유지한다.

UI 정책은 탭당 **20개씩 최대 3페이지, 총 60개**다.

## 현재 데이터 소스

### 영화

- 주 소스: KOFIC
- 파일: `assets/boxoffice.json`
- 수집기: `scripts/fetch-boxoffice.mjs`
- 포스터: KMDb 또는 TMDB
- 포스터 수집기: `scripts/fetch-posters.mjs`
- 최신성 판정: `content.html`의 `STALE_DAYS = 10`
- KOFIC 극장 애니메이션도 `type: 영화`로 유지한다.

### 애니

- 주 소스: MyAnimeList 데이터
- 접근 API: Jikan
- 파일: `assets/anime.json`
- 수집기: `scripts/fetch-anime.mjs`
- 정렬 기준: MAL `members` 내림차순
- 저장 상한: 60편
- 성인 등급/장르, 포스터 없는 작품, members 3000 미만 제외
- 한국어 제목: TMDB 키가 있을 경우 보조 조회
- 최초 Jikan 성공 전 fallback: KOFIC 애니메이션 영화 12편을 `assets/anime.json`에 seed로 저장
- Jikan 실패 시 `process.exit(0)`으로 전체 workflow는 살리고 기존 `anime.json` 유지

주의:
- Jikan은 비공식 API라 504 등 일시 장애 가능
- 외부 API 실패가 곧 빈 탭으로 이어지지 않도록 기존 파일을 보존하는 정책이 핵심

### 드라마 / 예능

- 주 소스: TMDB Discover TV
- 파일: `assets/tv-ranking.json`
- 수집기: `scripts/fetch-tv-ranking.mjs`
- 후보 조건:
  - `with_origin_country=KR`
  - `with_original_language=ko`
  - 최근 35일 방영
  - popularity 내림차순
- 최대 수집 페이지: 10
- 각 분류 저장 상한: 드라마 60편 / 예능 60편
- 최신성: `tv-ranking.json.updatedAt`가 14일 이내일 때 자동 데이터 사용
- 14일 초과 또는 파일 없음: 기존 `assets/content-data.json` 수동 데이터를 fallback으로 사용
- 자동 데이터가 60편을 꽉 채워도 수동 큐레이션이 완전히 사라지지 않도록 최대 5칸을 fallback으로 예약

## 한국형 예능 필터

규칙 파일: `assets/tv-ranking-rules.json`

### 강한 예능 신호

TMDB 장르:
- Reality (10764)
- Talk (10767)

한국어 키워드:
- 예능
- 리얼리티
- 버라이어티
- 토크쇼
- 오디션
- 서바이벌
- 경연
- 여행
- 먹방
- 관찰
- 연애 리얼리티
- 퀴즈
- 음악 예능

### 제외 신호

TMDB 장르:
- News
- Documentary
- Kids
- Animation

한국어 키워드:
- 뉴스
- 시사
- 다큐멘터리
- 교양
- 어린이
- 키즈
- 스포츠 중계

### 예외 처리

`whitelistVarietyIds`
- TMDB 분류가 이상해도 예능으로 강제 포함

`blacklistVarietyIds`
- 예능 후보로 잘못 잡히는 프로그램 강제 제외

운영 중 오탐을 발견하면 코드 대신 이 JSON의 TMDB TV id만 수정하는 것을 우선한다.

## 프론트 렌더링

파일: `content.html`

상수:
- `PER_PAGE = 20`
- `MAX_PAGES = 3`
- 모든 탭은 렌더 단계에서 최대 60건으로 cap

탭:
- 전체
- 영화
- 드라마
- 예능
- 애니

### 탭별 pool

영화:
- 수동 선정작 + KOFIC
- 제목 중복이면 수동 선정작 우선

드라마/예능:
- 신선한 `tv-ranking.json` 자동 데이터 우선
- 동일 제목 수동 데이터 제거
- 남는 수동 데이터를 뒤에 fallback으로 연결

애니:
- `anime.json` 전용
- Jikan 성공 후 MAL 데이터
- 최초 성공 전에는 seed fallback

전체:
- 수동 선정작 / KOFIC / 애니 / 자동 TV 4개 lane을 round-robin으로 혼합
- 각 lane 전체 길이를 합산한 `total`을 종료조건으로 사용
- 최종 화면에서는 최대 60건으로 cap

## 출처 데이터 모델

자동 데이터에는 가능한 한 아래 필드를 둔다.

`rankingSource`
- provider
- metric
- value 또는 rank
- observedAt

`metadataSource`
- 작품 기본 정보 출처

`posterCredit`
- 포스터 출처

향후에는 `providers`를 별도 필드로 분리하는 것이 좋다.

목표:
- ranking: 왜 이 작품이 노출되는가
- metadata: 제목/장르/포스터가 어디서 왔는가
- provider: 어디서 볼 수 있는가

세 역할을 분리한다.

## Workflow

파일: `.github/workflows/boxoffice.yml`

한국시간 오전 10시 실행.

순서:
1. KOFIC 박스오피스
2. npm ci
3. 포스터 다운로드
4. Jikan 애니
5. TMDB 드라마/예능
6. `assets` 변경분 commit/push

현재 commit message:
`Update content rankings`

외부 부가 데이터 실패는 가능하면 전체 workflow를 죽이지 않는 방향을 유지한다.

## 향후 확장 로직

### Naver DataLab Search Trend

예능/드라마 정확도가 부족할 경우 공식 API를 보조 신호로 추가한다.

초기 안:
- TMDB popularity 70%
- 네이버 최근 7일 검색 관심도 30%

단, DataLab 값은 절대 검색량이 아니라 상대 관심도이므로 화면에서 시청률처럼 표현하면 안 된다.

### Netflix Korea Top 10

TMDB와 별개로 Netflix 공식 한국 Top 10을 화제 콘텐츠 신호로 추가 검토.

원칙:
- Netflix Top 10 = 인기/랭킹 소스
- TMDB = 필요시 포스터/한국어 제목/메타데이터 보조
- Top 10 포함 여부만으로 Netflix Original이라고 판정하지 않는다.

### 네이버 시청률 크롤링

메인 파이프라인이 아니라 optional enhancement로만 검토.

권장 구조:
- 하루 1회 수집
- 성공값 cache
- 실패 시 직전 값 유지
- 일정 기간 이상 stale이면 화면에서 숨김
- 크롤러 실패가 콘텐츠 탭 실패로 전파되면 안 됨

## 2026-09-22 실제 TMDB 검증 결과

GitHub Actions에서 저장소의 `TMDB_API_KEY` Secret을 사용해 실제 TMDB 호출을 수행했다.

### 1차 생성 결과

- 드라마: 44편
- 예능: 60편
- 예능 상위권은 라디오스타, 아는 형님, 런닝맨, 나 혼자 산다 등 전형적인 국내 예능이 정상적으로 잡힘
- 명백한 오탐/부적합 6건 확인
  - TMDB 상태 오류 종영작: 해피투게더(5709), 위기탈출 넘버원(65269)
  - 예능 탭에서 제외할 음악 순위/공연 프로그램: 쇼! 음악중심(35024), SBS 인기가요(65278), 쇼! 챔피언(130013)
  - 교양 성격 전문 프로그램: TV 동물농장(64369)

위 6개는 `assets/tv-ranking-rules.json` blacklist에 반영했다.

### 현재성 보정

TMDB의 `Returning Series` / `in_production` 값만으로는 현재 방영 여부를 신뢰할 수 없었다.

따라서 TV 상세 API에서 아래를 추가 확인한다.

- `next_episode_to_air`가 있으면 유지
- `last_air_date`가 최근 35일이면 유지
- Returning/In Production 등 active status라도 다음 방송일이 없으면 최근 210일 안에 방영 기록이 있어야 유지
- 상세 조회 실패 시에는 정상 후보를 실수로 버리지 않도록 보수적으로 유지

이 보정 후 드라마 40편 / 예능 60편이 생성됐다.

### whitelist 검증

기존 수동 예능과 자동 결과를 대조했다.

- 유재석 캠프 → TMDB exact match 성공, TV id `318167`
- 히든싱어8 → TMDB exact match 없음
- 현역가왕3 → TMDB exact match 없음

`318167`은 `whitelistVarietyIds`에 넣었다.

whitelist는 이제 단순 분류 보정이 아니라 Discover 후보에 없더라도 TV 상세 API로 해당 ID를 직접 불러와 후보군에 강제 주입한다.

TMDB에 exact match가 없는 수동 큐레이션 작품이 자동 60개 때문에 화면에서 사라지지 않도록, 드라마/예능 탭은 자동 데이터가 60개를 꽉 채웠을 때 최대 5칸을 수동 fallback에 예약한다.

### 보정 후 상위 20 예능

1. 라디오스타
2. 아는 형님
3. 런닝맨
4. 나 혼자 산다
5. 놀라운 토요일
6. 1박 2일
7. 미운 우리 새끼
8. 놀면 뭐하니?
9. 전지적 참견 시점
10. 유 퀴즈 온 더 블럭
11. 냉장고를 부탁해
12. 핑계고
13. 리무진서비스
14. 어서와~ 한국은 처음이지?
15. 꼬리에 꼬리를 무는 그날 이야기
16. 나는 SOLO
17. 더 시즌즈
18. 나는 SOLO, 그 후 사랑은 계속된다
19. 벌거벗은 세계사
20. GOING SEVENTEEN

명백한 오탐 기준으로 1차 결과 6/60에서 보정 후 0건으로 줄였지만, 교양/웹예능을 어디까지 예능으로 볼지는 편집 정책에 따라 추가 조정 가능하다.

## 현재 검증 포인트

이미 확인:
- 브라우저 인라인 JS 문법 파싱 정상
- `assets/anime.json` JSON 파싱 정상
- 브랜치는 main 기반으로 생성됨
- main은 수정하지 않음

추가로 실제 운영 전에 반드시 확인:
1. GitHub Actions에서 TMDB 실제 응답으로 `tv-ranking.json` 생성되는지
2. 예능 오탐/누락 샘플 검토
3. whitelist/blacklist 1차 보정
4. Jikan 실제 성공 후 60편까지 정상 누적되는지
5. 전체/각 탭 1~3페이지 이동 확인
6. TMDB 포스터 URL의 화면 로딩 및 CORS/리퍼러 이슈 확인
7. 자동 데이터 14일 stale fallback 확인
8. GitHub Pages 배포 후 모바일/PC 레이아웃 확인

## 현재 브랜치 주요 변경 파일

- `content.html`
- `.github/workflows/boxoffice.yml`
- `scripts/fetch-anime.mjs`
- `scripts/fetch-tv-ranking.mjs`
- `assets/anime.json`
- `assets/tv-ranking-rules.json`

## 다음 개발자에게

가장 먼저 GitHub Actions 수동 실행으로 실제 데이터셋을 생성한 뒤 결과를 눈으로 검토한다.

예능 정확도가 부족하면 로직을 바로 복잡하게 만들지 말고:
1. whitelist/blacklist 보정
2. 키워드 수정
3. 후보 기간/페이지 수 조정
4. 그래도 부족하면 Naver DataLab 보조 신호

순으로 진행한다.

외부 소스는 언제든 실패할 수 있으므로 이 프로젝트의 기본 원칙은 항상:

**새 데이터 성공 시 교체 / 실패 시 마지막 정상 데이터 유지 / 빈 탭 금지**

다.
