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

이 저장소는 정적 HTML/CSS/브라우저 JavaScript 앱입니다. `server.js`는 로컬 미리보기용이며 Azure Static Web Apps에서는 실행하지 않습니다. 데이터베이스와 앱 런타임 환경변수는 현재 필요하지 않습니다.

- 배포 경로: 저장소 루트 `/`
- API 경로: 없음
- 빌드 산출물 경로: 없음
- Static Web Apps 빌드: 건너뜀
- CI 검사: Node.js 22에서 `npm run check`

초기 Azure 생성 워크플로는 `package.json`의 `build` 스크립트를 찾으려 해 실패했습니다. 현재 워크플로는 별도의 검사 작업을 먼저 실행하고, 성공한 경우에만 정적 파일을 업로드합니다. 검사 실패 시 배포 작업은 실행되지 않습니다.

## 비용과 무료 한도

Static Web Apps Free는 현재 가격표상 월 $0입니다. 포함 한도는 구독당 100GB 대역폭, 앱당 250MB 저장소/배포 크기, 앱당 사용자 지정 도메인 2개, 앱당 미리보기 환경 3개입니다. 할당량을 초과하면 사이트 제공이 제한될 수 있습니다. 유료 Standard 플랜은 가격표 기준 약 $9/앱/월부터이며 초과 대역폭 비용이 발생할 수 있습니다. 실제 가격은 구독 계약과 지역에 따라 확인하세요.

## Azure Portal 확인 절차

현재 리소스는 이미 생성되어 있습니다. Portal에서 같은 구성을 새로 만들거나 다시 연결할 때는 다음 값을 사용합니다.

### 새 Static Web App 생성

1. **Create a resource**에서 **Static Web Apps**를 선택합니다.
2. 구독은 `왕선중 백준기`, 리소스 그룹은 `rg-mapdule-prod`, 이름은 사용 가능한 이름, 플랜은 **Free**, 지역은 **East Asia**로 설정합니다.
3. 배포 원본은 **GitHub**로 선택하고 계정 `baekjungi`, 저장소 `MapDule`, 브랜치 `main`을 연결합니다.
4. 빌드 세부 설정은 **Custom**으로 지정하고 앱 위치는 `/`, API 위치와 출력 위치는 비워 둡니다.
5. 검토 후 생성합니다. Azure가 GitHub Actions 워크플로와 배포 Secret을 생성합니다.

### 현재 배포 확인

1. [Azure Portal](https://portal.azure.com/)에서 `rg-mapdule-prod` 리소스 그룹을 엽니다.
2. `mapdule-baekjungi` Static Web App 리소스를 선택합니다.
3. **Overview**에서 상태, 지역, 플랜, 기본 도메인을 확인합니다.
4. **Deployment history** 또는 GitHub 저장소의 **Actions** 탭에서 배포 결과를 확인합니다.
5. 설정을 변경할 때는 GitHub 연결이 `baekjungi/MapDule` / `main`인지 확인합니다.
6. 별도 백엔드가 없으므로 **Environment variables / Application settings**는 추가하지 않습니다.

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
2. 로컬에서 `npm run check`를 실행합니다.
3. 변경을 커밋하고 `main`에 푸시합니다.
4. GitHub Actions가 검사를 실행합니다.
5. 검사가 성공하면 Static Web Apps가 새 정적 파일을 배포합니다.
6. Actions의 두 작업과 위 웹사이트에서 결과를 확인합니다.

## 로컬 실행

```bash
npm run check
npm start
```

브라우저에서 `http://localhost:4173`을 엽니다. 앱 기능 코드는 Azure 배포를 위해 변경하지 않았습니다.

## 공식 문서

- [Static Web Apps 계획 및 한도](https://learn.microsoft.com/azure/static-web-apps/plans)
- [GitHub Actions 빌드 구성](https://learn.microsoft.com/azure/static-web-apps/build-configuration)
- [배포 토큰 관리](https://learn.microsoft.com/azure/static-web-apps/deployment-token-management)
- [Static Web Apps 가격](https://azure.microsoft.com/pricing/details/app-service/static/)
