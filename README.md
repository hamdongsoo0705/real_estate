# 네이버페이 부동산 매물 수집기

Playwright의 Chromium에서 네이버페이 부동산 페이지를 먼저 연 뒤, 같은 출처(origin)의 `fetch`로 단지별 매물 API를 호출합니다. 로그인이나 저장된 쿠키는 사용하지 않습니다. 차단·429·응답 형식 변경이 발생하면 우회하지 않고 작업을 실패 처리하며 `output/failures.json`에 원인을 남깁니다.

## 수집 기준

- 거래 유형: 매매(`A1`)만 요청
- 공급면적: 30평 이상 40평 미만 (`공급면적㎡ × 0.3025`)
- 중복: `representativeArticleInfo`와 대표 그룹 번호를 기준으로 한 매물로 취급
- 결과: 실제 공급면적별 가격 오름차순 1~3개
- 파일: `output/latest.json`, `output/latest.csv`

가격은 API가 제공하는 원 단위/만원 단위 표현을 임의로 변환하지 않고 숫자 그대로 저장합니다.

## 내 PC에서 시험하기

Node.js 20 이상을 설치한 뒤 이 폴더에서 다음을 실행합니다.

```powershell
npm install
npx playwright install chromium
npm test
npm run collect
```

수집 결과는 `output` 폴더에 생깁니다. 네이버 측 정책이나 실행 위치의 IP 평판에 따라 GitHub Actions에서는 요청이 거절될 수 있습니다.

## 단지 추가·수정

`complexes.json` 배열에 단지를 추가합니다.

```json
{
  "complexNumber": 107482,
  "complexName": "마곡엠밸리1단지",
  "enabled": true
}
```

API가 단지명을 돌려주면 그것을 우선 사용하고, 없으면 설정의 `complexName`을 사용합니다. 잠시 제외하려면 `enabled`를 `false`로 바꿉니다.

## GitHub에서 매일 자동 실행하기

1. GitHub에 로그인한 뒤 **New repository**로 빈 저장소를 만듭니다. README나 `.gitignore` 자동 생성은 선택하지 않아도 됩니다.
2. 이 프로젝트 폴더 전체를 저장소에 올립니다. 웹 화면의 **Add file → Upload files**를 이용해도 됩니다. `.github/workflows/daily.yml` 같은 점으로 시작하는 폴더도 빠짐없이 포함해야 합니다.
3. 저장소의 **Actions** 탭을 열고 워크플로 실행을 허용합니다.
4. 왼쪽에서 **Daily apartment listing report**를 선택하고 **Run workflow**를 누르면 즉시 시험할 수 있습니다.
5. 성공 또는 실패한 실행을 열고 아래쪽 **Artifacts**의 `apartment-report-...`를 내려받으면 JSON/CSV와 진단 파일을 볼 수 있습니다.

예약 실행은 매일 한국시간 오전 8시입니다. GitHub 예약 작업은 혼잡할 때 수 분 이상 늦게 시작될 수 있습니다. 워크플로의 cron은 UTC 기준 전날 23시(`0 23 * * *`)입니다.

## 실패 확인

- 실행 로그의 `[FAILED]` 줄과 내려받은 `output/failures.json`을 확인합니다.
- HTTP 429/403이면 재시도 폭주, 프록시, CAPTCHA 회피, 쿠키 탈취 같은 우회를 하지 않습니다.
- 페이지 또는 API 응답 구조가 바뀌었다면 `src/normalize.js`의 필드 매핑을 새 응답에 맞게 갱신합니다.
- 모든 단지가 실패하면 Actions 실행도 실패(빨간색)하지만, `if: always()` 덕분에 가능한 진단 파일은 artifact로 올라갑니다.

## 참고 사항

이 도구는 공개 화면에서 로그인 없이 제공되는 응답만 시도합니다. 서비스 이용약관, robots 정책, 관련 법규를 확인하고 낮은 빈도로 사용하세요. 각 단지는 API의 `lastInfo` 커서가 끝날 때까지만 순차 조회하며 자동 재시도는 없습니다. 비정상 응답에 대비해 단지당 최대 100페이지로 제한됩니다.
