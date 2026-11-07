# Azure 배포 및 CI/CD

## 현재 배포 대상

- Azure 서비스: Azure Static Web Apps
- 플랜: Free
- 리소스 그룹: `rg-mapdule-prod`
- Static Web App: `mapdule-baekjungi`
- 지역: East Asia
- GitHub 저장소: `baekjungi/MapDule`
- 배포 브랜치: `main`
- 웹사이트: https://gentle-beach-07f533300.1.azurestaticapps.net

## 프로젝트 구성

프런트엔드는 정적 HTML/CSS/브라우저 JavaScript 앱이고, `server.js`는 로컬 미리보기용입니다. 배포 사이트의 `/api/ai/*`는 `api/` 아래 Azure Functions가 처리합니다. 브라우저에는 Azure OpenAI 키를 보내지 않습니다.

- 배포 경로: 공개 파일만 포함하는 `dist/`
- API 경로: `api/`의 Azure Functions (`/api/ai/*`, `/api/family/*`, `/api/mobility/*`, `/api/push/*`)
- API 런타임: `staticwebapp.config.json`에서 Node.js 22
- 빌드 산출물 경로: `dist/` (기존 화면 자산과 `departure-push.js`, `sw.js`, `manifest.webmanifest`, `app-icon.svg`, `staticwebapp.config.json`)
- Static Web Apps 빌드: GitHub Actions에서 `npm run build` 실행 후 산출물만 업로드
- CI 검사: Node.js 22에서 `npm run check`, `npm test`, `npm run build`

GitHub Actions는 앱 빌드를 실행해 공개 파일만 `dist/`로 복사합니다. 저장소 루트의 서버 코드, 문서, 설정 및 테스트 파일은 배포 산출물에 포함하지 않습니다. 검사 실패 시 배포 작업은 실행되지 않습니다.

## 비용과 무료 한도

Static Web Apps Free는 현재 가격표상 월 $0입니다. 포함 한도는 구독당 100GB 대역폭, 앱당 250MB 저장소/배포 크기, 앱당 사용자 지정 도메인 2개, 앱당 미리보기 환경 3개입니다. 할당량을 초과하면 사이트 제공이 제한될 수 있습니다. 유료 Standard 플랜은 가격표 기준 약 $9/앱/월부터이며 초과 대역폭 비용이 발생할 수 있습니다. 실제 가격은 구독 계약과 지역에 따라 확인하세요.

## Azure Portal 확인 절차

현재 리소스는 이미 생성되어 있습니다. Portal에서 같은 구성을 새로 만들거나 다시 연결할 때는 다음 값을 사용합니다.

### 새 Static Web App 생성

1. **Create a resource**에서 **Static Web Apps**를 선택합니다.
2. 구독은 `왕선중 백준기`, 리소스 그룹은 `rg-mapdule-prod`, 이름은 사용 가능한 이름, 플랜은 **Free**, 지역은 **East Asia**로 설정합니다.
3. 배포 원본은 **GitHub**로 선택하고 계정 `baekjungi`, 저장소 `MapDule`, 브랜치 `main`을 연결합니다.
4. 빌드 세부 설정은 **Custom**으로 지정하고, GitHub Actions가 `npm run build`를 실행한 뒤 앱 위치 `dist`, API 위치 `api`, 출력 위치는 비워 두도록 설정합니다.
5. 검토 후 생성합니다. Azure가 GitHub Actions 워크플로와 배포 Secret을 생성합니다.

### 현재 배포 확인

1. [Azure Portal](https://portal.azure.com/)에서 `rg-mapdule-prod` 리소스 그룹을 엽니다.
2. `mapdule-baekjungi` Static Web App 리소스를 선택합니다.
3. **Overview**에서 상태, 지역, 플랜, 기본 도메인을 확인합니다.
4. **Deployment history** 또는 GitHub 저장소의 **Actions** 탭에서 배포 결과를 확인합니다.
5. 설정을 변경할 때는 GitHub 연결이 `baekjungi/MapDule` / `main`인지 확인합니다.
6. **Configuration**의 애플리케이션 설정에 아래 Azure OpenAI 설정을 추가합니다. 값은 비밀이므로 브라우저 코드, GitHub 저장소, 배포 로그에 넣지 마세요.

   - `AZURE_OPENAI_ENDPOINT`: Azure OpenAI 리소스의 HTTPS endpoint
   - `AZURE_OPENAI_API_KEY`: Azure OpenAI API key
   - `AZURE_OPENAI_DEPLOYMENT`: 배포된 모델의 deployment 이름

`AZURE_OPENAI_ENDPOINT`에는 리소스 기본 주소 또는 `/openai/v1` endpoint를 사용합니다. `/openai/v1/responses`로 끝나는 주소는 Responses API로 호출됩니다.

7. 설정을 저장한 뒤 Static Web App API 설정이 반영되도록 배포를 다시 실행합니다. API 키는 API 함수의 서버 환경변수로만 읽힙니다.

AI 일정 분석·일정 계산 API(`/api/ai/parse`, `/api/ai/plan`)는 계정 없이 사용할 수 있습니다. AI 설정 상태 API(`/api/ai/status`)는 `authRequired: false`와 서버 설정 여부만 반환하며 API 키를 노출하지 않습니다. API 키와 모델 호출은 계속 서버에서만 처리합니다.

`/api/ai/plan`은 일정 사이 이동 시간·여유·권장 출발 시각을 서버 코드로 직접 계산합니다. Azure OpenAI는 요약과 제안에만 사용하며, 설정이 없거나 응답이 늦어도 계산 결과는 그대로 반환됩니다(`aiSummary: false`, 필요 시 `aiNotice`). 선택 설정 `KAKAO_REST_API_KEY`는 자동차 길찾기와 카카오 장소 검색에 사용합니다. `ODSAY_API_KEY`는 도보·대중교통 경로 조회에 사용합니다. 키 미설정·조회 실패·미지원 구간은 출처가 표시된 직선거리 추정으로 대체합니다. 대중교통은 도보 포함 경로 시간이며 실시간 지연·첫차·막차는 별도 확인이 필요합니다. 도시간 응답은 터미널 접근 경로가 불완전하므로 추정으로 대체합니다. ODsay 도보 API 권한과 카카오모빌리티 길찾기 사용 권한·요금은 각 공급자에서 확인하세요.

## 장소 비교 API

`GET /api/mobility/status`는 키 설정 여부만 반환합니다. `POST /api/mobility/search`는 장소 검색, `/nearby`는 출발지 가운데 좌표 주변의 실제 장소 후보 검색, `/midpoint`는 후보별 경로 비교입니다. 참가자 최대 6명, 후보 최대 5곳이며 경로 조회는 후보 단위로 제한해 한 번에 최대 6개가 실행됩니다. 공급자 요청은 5초 제한입니다. 이동 API에는 AI와 별개로 IP별 분당 10회·일당 100회, 인스턴스 동시 3회 제한을 적용합니다. 이는 전역 비용 상한이 아니므로 공급자 할당량·경보를 별도 설정하세요. 실제 키를 이용한 호출은 이번 로컬 검증에 포함되지 않았습니다.

## 닫힌 앱 출발 푸시

추가 비용이 발생할 수 있는 예약 실행 서비스와 저장소 설정은 운영자가 확인 후 진행합니다. 이번 변경은 코드·로컬 검증만 포함하며 실제 클라우드 키·설정·배포는 변경하지 않았습니다.

1. `api/`의 의존성을 설치합니다(`npm install --prefix api`). VAPID 키는 `npx --prefix api web-push generate-vapid-keys`로 운영자 터미널에서 생성할 수 있습니다. 출력되는 개인 키를 채팅·로그·저장소에 올리지 마세요.
2. 서버 환경 변수에 `MAPDULE_VAPID_PUBLIC_KEY`, `MAPDULE_VAPID_PRIVATE_KEY`, `MAPDULE_VAPID_SUBJECT`(운영자 `mailto:` 주소 또는 HTTPS 연락처)를 등록합니다. 공개 키만 브라우저로 전달됩니다.
3. 배포 환경에는 `MAPDULE_STORAGE_CONNECTION_STRING`과 32자 이상의 임의 비밀값 `MAPDULE_PUSH_DISPATCH_KEY`도 필요합니다. 푸시 전용 `mapdulepush` 테이블을 사용합니다. 로컬 서버는 `.mapdule-data/push-dev.json`을 사용하며 한 프로세스로만 실행합니다.
4. Static Web Apps API는 HTTP 전용입니다. 관리형 API에 타이머 트리거를 추가하지 않습니다. 별도 예약 서비스에서 약 30초~1분마다 `POST https://<앱 주소>/api/push/dispatch`를 호출하도록 구성하세요. 헤더는 `Content-Type: application/json`, `Authorization: Bearer <MAPDULE_PUSH_DISPATCH_KEY>`, 본문은 `{}`입니다. 비밀값은 예약 서비스의 비밀 저장소에서 가져오고 URL 쿼리에 넣지 않습니다. 예약 서비스의 과금·장애 알림은 별도 관리합니다.
5. `/api/push/status`의 `enabled: true`를 확인하고 실제 HTTPS 사이트에서 일정 계산 후 출발 알림을 켭니다. iOS/iPadOS 16.4 이상은 홈 화면에 추가한 앱에서 허용해야 합니다. 탭을 닫은 실제 기기에서 수신·클릭·취소를 검증하고 예약 실행 로그의 `attempted`, `sent`도 확인하세요. `enabled`는 환경 설정 여부이며 예약 서비스가 실제 실행 중임을 검사하지 않습니다.

예약·취소 API는 브라우저가 생성한 256비트 기기 토큰으로 해당 푸시 구독을 보호합니다. 토큰은 사용자 계정 인증이나 기기 간 동기화 기능이 아닙니다. 구독별 최대 20개, 미래 7일 이내 예약만 허용하고 한 번의 등록은 이 기기의 기존 예약을 교체합니다. 서버는 사용자가 지정한 임의 URL이 아니라 허용된 Chrome/Firefox/Apple/Windows 푸시 호스트에만 전송합니다. 서버에 보관되는 정보는 구독 주소·구독 키·알림 문구·발송 시각이며 위치 좌표는 푸시 예약에 저장하지 않습니다.

한 번의 예약 실행은 최대 5개(구독당 1개)를 전송하고 다음 실행에서 나머지를 처리합니다. 중복을 피하기 위해 발송 전에 예약을 원자적으로 소비합니다. 전송 실패·프로세스 종료 때 자동 재시도하지 않으므로 누락될 수 있으며, 지각 알람 전체를 대신하지 않습니다. 일정 시작 후에는 보내지 않고 구독이 만료되면 남은 예약을 비웁니다. 마지막 예약 등록 8일 뒤 예약 실행 시 구독 키·문구를 지우며 소유권 해시만 남깁니다. 저장소 장애·대규모 구독에서는 API의 45초 제한을 넘을 수 있으므로 별도 큐·발송 워커로 확장해야 합니다. 이 작업에서는 실제 Web Push 공급자 전송과 Azure 저장소를 검증하지 않았습니다.

AI 분석·일정 계산·설정 조회는 JSON을 읽기 전에 HTTP 상태와 응답 형식을 확인합니다. HTML 오류 페이지나 잘못된 JSON을 받은 경우에도 원문 파서 오류 대신 연결 오류를 안내하며 기존 입력 내용은 유지합니다.

익명 AI 요청에는 IP별 분당 10회·24시간당 100회, 서버 인스턴스당 동시 실행 3회 제한이 적용됩니다. 분석과 일정 계산은 같은 한도를 공유합니다. 초과 시 429 응답과 `Retry-After` 대기 시간이 제공됩니다. IP는 제한 기록에서 해시로만 보관하며 원문을 로그에 남기지 않습니다. 한도는 인스턴스 메모리에 있으므로 재시작·다중 인스턴스 환경의 전역 비용 상한은 아닙니다. 운영 Azure OpenAI의 토큰·요청 할당량과 비용 경보도 별도로 설정하세요.

## 가족 공유 저장소

가족 일정과 이동 상태를 Azure에 저장하려면 Static Web App의 애플리케이션 설정에 `MAPDULE_STORAGE_CONNECTION_STRING`을 추가해야 합니다. 값은 전용 Storage 계정의 연결 문자열로 설정하고, 소스 코드나 GitHub 저장소에 넣지 마세요. 설정이 없으면 가족 화면은 비활성 상태를 안내하며 개인 일정 기능은 계속 동작합니다. 로컬 `npm start`는 `.mapdule-data/family-dev.json`을 사용합니다.

- Table Storage의 REST 호출은 15초 시간 제한을 둡니다. 실제 Azure 계정에 연결 문자열을 등록한 뒤 `/api/family/status`가 `available: true`를 반환하는지 확인하세요. 이 환경에서는 실제 Azure 저장소 연결을 검증하지 않았습니다.
- 출발을 알린 동안에만 위치를 전송합니다. 도착 또는 공유 중지 시 저장된 경로 좌표를 지우며, 종료 이동의 표시 레코드는 최대 12시간 뒤 다음 가족 상태 조회에서 삭제됩니다.
- 초대·가족 생성에는 IP 기반 요청 제한이 적용됩니다. 제한 기록은 Functions 인스턴스 메모리에 있어 배포 인스턴스 전체에서 공유되지는 않습니다. 이용량이 커지면 Azure API Management 등 분산 제한 계층을 추가해야 합니다.
- 연결 문자열 방식은 전용 Storage 계정에서만 사용하고, 공유·회전 정책을 따르세요. 운영 확장 시에는 관리 ID 기반 Table 접근으로 전환하는 것이 좋습니다.
- 로컬 가족 저장소는 각 변경을 임시 파일에 기록·동기화한 뒤 원본 파일을 교체합니다. 저장 실패는 요청 오류로 반환하고 메모리 변경도 취소합니다. 기존 파일이 손상되거나 읽기 권한이 없으면 빈 가족 데이터로 덮어쓰지 않습니다. 이 경우 원본을 보관한 뒤 백업·권한을 확인하세요. 로컬 파일 저장소는 한 서버 프로세스에서만 사용하고, 여러 서버를 실행할 때는 서버마다 별도 데이터 파일 또는 운영 저장소를 사용하세요.
- AI·가족 API는 스트리밍 요청 본문에도 16KiB 제한을 적용하며, 본문 수신 실패는 JSON 오류 응답으로 처리합니다. 요청 제한 응답(429)의 `Retry-After`는 60초입니다.

## GitHub Actions 및 인증

Azure가 GitHub 저장소에 `.github/workflows/azure-static-web-apps-gentle-beach-07f533300.yml`을 생성하고, 앱 전용 배포 토큰을 저장소 Actions Secret으로 등록했습니다. 워크플로 파일에는 토큰 값이 없고 Secret 이름만 참조합니다. 토큰 값은 로그나 코드에 복사하지 마세요.

Static Web Apps의 기본 배포 작업은 `azure_static_web_apps_api_token`을 요구합니다. Microsoft의 OIDC 예제도 이 배포 토큰 입력을 함께 사용하므로, 이 파이프라인은 Azure 서비스 주체 자격 증명 대신 Azure가 생성한 앱 전용 GitHub Secret을 사용합니다. 토큰이 노출되면 Portal의 **Manage deployment token**에서 재생성하고 해당 GitHub Secret을 갱신하세요.

## 배포 확인

- GitHub: `baekjungi/MapDule` → **Actions** → **Azure Static Web Apps CI/CD**
- 성공 조건: `Validate application` 작업 성공 후 `Build and Deploy Job` 성공
- 실패 시: 실패한 작업을 열어 첫 오류를 확인합니다. Validate가 실패하면 배포는 자동으로 차단됩니다.
- 웹사이트: https://gentle-beach-07f533300.1.azurestaticapps.net

## 이후 배포 흐름

1. 코드와 설정을 수정합니다.
2. Azure Portal의 Static Web App 애플리케이션 설정에 세 가지 Azure OpenAI 설정값이 있는지 확인합니다.
3. 로컬에서 `npm run check`, `npm test`, `npm run build`를 실행합니다.
4. 변경을 `main`에 푸시합니다.
5. GitHub Actions가 검사를 실행하고 `api/`의 Azure Functions API와 정적 프런트엔드를 함께 배포합니다.
6. Actions의 두 작업과 위 웹사이트에서 결과를 확인합니다. AI 화면의 설정 상태가 `Azure OpenAI 준비됨`이어야 합니다.

## 로컬 실행

```bash
npm run check
npm start
```

브라우저에서 `http://localhost:4173`을 엽니다. 로컬 개발은 `.env`를 사용하고, 배포 앱은 Azure Portal의 Static Web App 애플리케이션 설정을 사용합니다.

## 공식 문서

- [Static Web Apps 계획 및 한도](https://learn.microsoft.com/azure/static-web-apps/plans)
- [GitHub Actions 빌드 구성](https://learn.microsoft.com/azure/static-web-apps/build-configuration)
- [배포 토큰 관리](https://learn.microsoft.com/azure/static-web-apps/deployment-token-management)
- [Static Web Apps 가격](https://azure.microsoft.com/pricing/details/app-service/static/)
