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
- API 경로: `api/`의 Azure Functions (`/api/ai/*`, `/api/family/*`)
- API 런타임: `staticwebapp.config.json`에서 Node.js 22
- 빌드 산출물 경로: `dist/` (`index.html`, `app.js`, `styles.css`, `family.js`, `family.css`, `staticwebapp.config.json`)
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

AI 일정 분석 API(`/api/ai/parse`)는 Azure Static Web Apps의 `authenticated` 역할이 있어야 호출할 수 있습니다. 앱의 AI 화면에서 Microsoft 계정으로 로그인한 뒤 사용하고, 로그아웃하면 다시 호출할 수 없습니다. AI 설정 상태 API(`/api/ai/status`)는 API 키를 반환하지 않고 설정 여부만 알려줍니다. Azure OpenAI의 사용량 한도와 모니터링도 계속 설정하세요.

## 가족 공유 저장소

가족 일정과 이동 상태를 Azure에 저장하려면 Static Web App의 애플리케이션 설정에 `MAPDULE_STORAGE_CONNECTION_STRING`을 추가해야 합니다. 값은 전용 Storage 계정의 연결 문자열로 설정하고, 소스 코드나 GitHub 저장소에 넣지 마세요. 설정이 없으면 가족 화면은 비활성 상태를 안내하며 개인 일정 기능은 계속 동작합니다. 로컬 `npm start`는 `.mapdule-data/family-dev.json`을 사용합니다.

- Table Storage의 REST 호출은 15초 시간 제한을 둡니다. 실제 Azure 계정에 연결 문자열을 등록한 뒤 `/api/family/status`가 `available: true`를 반환하는지 확인하세요. 이 환경에서는 실제 Azure 저장소 연결을 검증하지 않았습니다.
- 출발을 알린 동안에만 위치를 전송합니다. 도착 또는 공유 중지 시 저장된 경로 좌표를 지우며, 종료 이동의 표시 레코드는 최대 12시간 뒤 다음 가족 상태 조회에서 삭제됩니다.
- 초대·가족 생성에는 IP 기반 요청 제한이 적용됩니다. 제한 기록은 Functions 인스턴스 메모리에 있어 배포 인스턴스 전체에서 공유되지는 않습니다. 이용량이 커지면 Azure API Management 등 분산 제한 계층을 추가해야 합니다.
- 연결 문자열 방식은 전용 Storage 계정에서만 사용하고, 공유·회전 정책을 따르세요. 운영 확장 시에는 관리 ID 기반 Table 접근으로 전환하는 것이 좋습니다.

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
