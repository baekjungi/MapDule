# MapDule (맵듈)

월간 일정표에서 날짜별 일정과 이동 경로를 확인하는 모바일 우선 일정 관리 UI 프로토타입입니다.

## 현재 구현 범위

- 월간·주간·일간·일정 목록 보기와 날짜별 일정 표시
- 사이드바 미니 달력 및 캘린더별 일정 표시 필터
- 모바일 화면의 선택 날짜 일정 카드 및 빠른 일정 추가 버튼
- 달력 빈 날짜에서 일정 생성, 일정 배지에서 수정·삭제
- 종일 일정, 시간, 캘린더, 장소, 메모를 관리하는 공통 일정 모달
- 모바일 햄버거 사이드바와 바텀 시트 일정 모달
- 날짜를 선택해 상세 타임라인과 이동 경로를 확인하는 화면
- 상단의 AI 일정 등록 진입 버튼
- 지각 위험 알림 카드
- 이동 시간 블록과 자투리 시간 퀘스트
- AI 자연어 일정 등록 미리보기
- 약속 지점 추천 화면
- 프로필 설정 저장
- 수동 일정 등록, 수정, 삭제 및 시간 중복 방지
- `.ics` 캘린더 내보내기와 JSON 백업·복원·초기화
- 모바일·데스크톱 반응형 레이아웃
- 가족 그룹: 초대 코드·링크, 공유 일정 및 참석자 선택
- 출발 알리기부터 도착까지의 위치 공유와 가족 지도

프로필과 개인 일정은 브라우저 로컬 저장소에 저장됩니다. 가족 일정과 이동 상태는 로컬에서 `.mapdule-data/` 파일, Azure 배포에서는 Table Storage에 저장합니다. Azure에 `MAPDULE_STORAGE_CONNECTION_STRING`을 등록해야 가족 공유 기능이 활성화됩니다. 자세한 내용은 [DEPLOYMENT.md](DEPLOYMENT.md)를 참고하세요.

AI 일정 분석은 서버에서 Azure OpenAI를 호출하며 브라우저에는 API 키를 전달하지 않습니다. 대중교통·도로 길찾기 API는 아직 연결되지 않아 도착 예상 시간은 직선거리 기반 추정입니다.

카카오 지도를 연결하려면 `index.html`의 `kakao-javascript-key` 메타 태그에 Kakao Developers의 JavaScript 키를 입력하고, Kakao Developers의 Web 플랫폼에 로컬 및 배포 도메인을 허용 목록으로 등록합니다. 키는 브라우저에 공개되므로 JavaScript 키만 사용하고 도메인 제한을 설정하세요.

## 실행

요구사항: Node.js 18 이상

로컬에서 Azure OpenAI 분석을 사용하려면 `.env.example`을 복사해 `.env`를 만들고 발급받은 값으로 채웁니다.

```env
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
```

실제 `.env`는 Git에서 제외됩니다. 키를 커밋하거나 브라우저 코드에 넣지 마세요. 설정 후 서버를 재시작합니다. 배포 사이트 설정은 [DEPLOYMENT.md](DEPLOYMENT.md)를 참고하세요.

```bash
npm run check
npm start
```

브라우저에서 `http://localhost:4173`을 엽니다. 포트는 `PORT` 환경 변수로 바꿀 수 있습니다.
AI 등록 화면에 문장을 입력하고 **AI로 일정 분석**을 누른 뒤, 분석된 일정과 시간을 확인하고 등록합니다.

```powershell
$env:PORT=8080
npm start
```

## 배포

이 프로젝트는 정적 웹앱이며, 배포 시 공개할 HTML·CSS·JavaScript만 `dist/`에 모읍니다.

- Azure Static Web Apps Free에 배포되어 있습니다.
- `main` 브랜치에 푸시하면 GitHub Actions 검사 후 자동 배포됩니다.
- Azure 연결 정보, 무료 한도, 장애 확인 방법은 [DEPLOYMENT.md](DEPLOYMENT.md)를 참고합니다.

실제 서비스로 전환하기 전에 다음 작업이 필요합니다.

1. 인증과 사용자별 일정 저장소 연결
2. 지도·장소 검색 API 서버 연동
3. 대중교통·도로 이동 시간 API 연동
4. 자연어 분석 API 연동
5. 위치 및 알림 권한 처리
6. API 키를 서버 환경 변수로 관리
7. 실제 일정 생성·이동 블록·지각 알림 테스트 추가

제품 요구사항은 [prd.md](prd.md), 개발 지침은 [agent.md](agent.md)를 참고합니다.
