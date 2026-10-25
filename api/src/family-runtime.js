const { createFamilyService, FamilyError } = require('./family-service');
const { createTableStore, createFileStore } = require('./family-store');

// 요청 처리기를 한 번만 만들어 재사용한다.
// - 배포(Azure Functions): MAPDULE_STORAGE_CONNECTION_STRING 이 있으면 Azure Table Storage 사용
// - 로컬(server.js): 연결 문자열이 없으면 data/family-dev.json 파일에 저장
let cachedService = null;

function connectionString() {
  return process.env.MAPDULE_STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING || '';
}

function getFamilyService({ localFilePath } = {}) {
  if (cachedService) return cachedService;
  if (connectionString()) {
    cachedService = createFamilyService({ store: createTableStore(connectionString()) });
  } else if (localFilePath) {
    cachedService = createFamilyService({ store: createFileStore(localFilePath) });
  }
  return cachedService;
}

function getFamilyStatus(options) {
  const service = getFamilyService(options);
  return { available: Boolean(service), storage: service ? service.storageKind : 'none' };
}

async function handleFamilyRequest(request, options) {
  if (request.action === 'status' && String(request.method).toUpperCase() === 'GET') {
    return { status: 200, body: getFamilyStatus(options) };
  }
  const service = getFamilyService(options);
  if (!service) {
    return {
      status: 503,
      body: {
        error: '가족 공유 기능의 서버 저장소가 아직 설정되지 않았습니다.',
        code: 'FAMILY_STORAGE_NOT_CONFIGURED'
      }
    };
  }
  try {
    return { status: 200, body: await service.handle(request) };
  } catch (error) {
    if (error instanceof FamilyError) {
      return { status: error.statusCode, body: { error: error.message, code: error.code } };
    }
    throw error;
  }
}

module.exports = { handleFamilyRequest, getFamilyStatus };
