function getAiStatus() {
  return {
    configured: Boolean(
      process.env.AZURE_OPENAI_ENDPOINT
      && process.env.AZURE_OPENAI_API_KEY
      && process.env.AZURE_OPENAI_DEPLOYMENT
    )
  };
}

function createAiError(statusCode, message, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function getKoreaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateExtractedEvents(data) {
  if (!data || !Array.isArray(data.events) || data.events.length > 20) {
    throw new Error('AI returned an invalid event list.');
  }
  const categories = new Set(['약속', '업무', '운동', '개인', '기타']);
  const events = data.events.map((event) => {
    if (!event || typeof event !== 'object'
      || typeof event.title !== 'string' || !event.title.trim()
      || !isValidDate(event.date)
      || typeof event.allDay !== 'boolean'
      || !categories.has(event.category)
      || typeof event.location !== 'string'
      || typeof event.notes !== 'string') {
      throw new Error('AI returned an invalid event.');
    }
    if (event.allDay) {
      return {
        title: event.title.trim().slice(0, 80),
        date: event.date,
        startTime: '00:00',
        endTime: '23:59',
        allDay: true,
        category: event.category,
        location: event.location.trim().slice(0, 120),
        notes: event.notes.trim().slice(0, 300)
      };
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.startTime)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(event.endTime)
      || event.endTime <= event.startTime) {
      throw new Error('AI returned an invalid event time.');
    }
    return {
      title: event.title.trim().slice(0, 80),
      date: event.date,
      startTime: event.startTime,
      endTime: event.endTime,
      allDay: false,
      category: event.category,
      location: event.location.trim().slice(0, 120),
      notes: event.notes.trim().slice(0, 300)
    };
  });
  return {
    events,
    assumptions: Array.isArray(data.assumptions)
      ? data.assumptions.filter((item) => typeof item === 'string').slice(0, 10)
      : []
  };
}

async function requestAzureOpenAIJson(systemMessage, userMessage, temperature = 0.2, {
  invalidResponseCode = 'AZURE_OPENAI_INVALID_RESPONSE',
  invalidResponseMessage = 'Azure OpenAI가 올바른 구조의 JSON을 반환하지 않았습니다.'
} = {}) {
  const { configured } = getAiStatus();
  if (!configured) {
    throw createAiError(
      503,
      'Azure OpenAI 서버 설정이 없습니다. 배포 환경의 애플리케이션 설정을 확인해 주세요.',
      'AZURE_OPENAI_NOT_CONFIGURED'
    );
  }

  let url;
  try {
    url = new URL(process.env.AZURE_OPENAI_ENDPOINT);
  } catch {
    throw createAiError(500, 'AZURE_OPENAI_ENDPOINT 주소가 올바르지 않습니다.', 'INVALID_AZURE_ENDPOINT');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw createAiError(500, 'AZURE_OPENAI_ENDPOINT는 자격 증명이 포함되지 않은 HTTPS 주소여야 합니다.', 'INVALID_AZURE_ENDPOINT');
  }
  const endpointPath = url.pathname.replace(/\/+$/, '');
  const versionedEndpoint = endpointPath.match(/^(.*\/openai\/v1)(?:\/(responses|chat\/completions))?$/);
  let apiMode = 'chat';
  if (versionedEndpoint) {
    apiMode = versionedEndpoint[2] === 'responses' ? 'responses' : 'chat';
    url.pathname = `${versionedEndpoint[1]}/${apiMode === 'responses' ? 'responses' : 'chat/completions'}`;
  } else if (!endpointPath) {
    url.pathname = '/openai/v1/chat/completions';
  } else {
    throw createAiError(
      500,
      'AZURE_OPENAI_ENDPOINT에는 Azure OpenAI 리소스 주소 또는 /openai/v1 endpoint를 입력해 주세요.',
      'INVALID_AZURE_ENDPOINT'
    );
  }
  url.search = '';

  const requestBody = apiMode === 'responses'
    ? {
      model: process.env.AZURE_OPENAI_DEPLOYMENT,
      instructions: systemMessage,
      input: userMessage,
      text: { format: { type: 'json_object' } }
    }
    : {
      model: process.env.AZURE_OPENAI_DEPLOYMENT,
      response_format: { type: 'json_object' },
      temperature,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ]
    };

  let azureResponse;
  try {
    azureResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(45_000)
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    console.error(timedOut ? 'Azure OpenAI request timed out.' : 'Azure OpenAI request could not be completed.');
    throw createAiError(
      502,
      timedOut ? 'Azure OpenAI 응답 시간이 초과됐습니다. 다시 시도해 주세요.' : 'Azure OpenAI에 연결할 수 없습니다. endpoint와 네트워크를 확인해 주세요.',
      timedOut ? 'AZURE_OPENAI_TIMEOUT' : 'AZURE_OPENAI_CONNECTION_FAILED'
    );
  }

  if (!azureResponse.ok) {
    let azureErrorCode;
    try {
      azureErrorCode = (await azureResponse.json()).error?.code;
    } catch {
      azureErrorCode = undefined;
    }
    console.error(`Azure OpenAI request failed with status ${azureResponse.status}${azureErrorCode ? ` (${azureErrorCode})` : ''}.`);
    if (azureResponse.status === 429) {
      throw createAiError(503, 'Azure OpenAI 사용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.', 'AZURE_OPENAI_RATE_LIMITED');
    }
    if (azureResponse.status === 401 || azureResponse.status === 403) {
      throw createAiError(502, 'Azure OpenAI 인증에 실패했습니다. API key와 배포 권한을 확인해 주세요.', 'AZURE_OPENAI_AUTH_FAILED');
    }
    throw createAiError(502, `Azure OpenAI 요청이 실패했습니다 (HTTP ${azureResponse.status}). endpoint와 deployment 설정을 확인해 주세요.`, 'AZURE_OPENAI_REQUEST_FAILED');
  }

  let completion;
  try {
    completion = await azureResponse.json();
  } catch {
    throw createAiError(502, 'Azure OpenAI가 올바른 JSON 응답을 반환하지 않았습니다.', 'AZURE_OPENAI_INVALID_RESPONSE');
  }
  const output = Array.isArray(completion?.output) ? completion.output : [];
  const content = apiMode === 'responses'
    ? output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .find((item) => item?.type === 'output_text')?.text || completion?.output_text
    : completion?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw createAiError(502, 'Azure OpenAI 응답에서 일정 내용을 찾지 못했습니다.', 'AZURE_OPENAI_EMPTY_RESPONSE');
  }
  try {
    return JSON.parse(content);
  } catch {
    throw createAiError(502, invalidResponseMessage, invalidResponseCode);
  }
}

async function parseSchedulePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
    throw createAiError(400, '일정 문장을 1~4,000자 사이로 입력해 주세요.', 'INVALID_PROMPT');
  }
  const systemMessage = `너는 한국어 일정 문장을 캘린더 일정으로 변환하는 도우미다. 기준 날짜는 한국 시간 오늘 ${getKoreaDate()}이다. 상대 날짜(오늘, 내일, 모레, 이번 주 금요일 등)는 이 기준으로 계산한다. 사용자가 명시한 일정만 분리하고, 최대 20개까지 반환한다. 시간이 없으면 오전 9시 시작, 1시간 일정으로 설정하고 assumptions에 그 가정을 알린다. 종료 시간이 없으면 시작 시간부터 1시간으로 설정한다. 종일 여부가 명확할 때만 allDay를 true로 한다. category는 약속, 업무, 운동, 개인, 기타 중 하나다. 모든 문자열은 한국어로 작성한다. 반드시 json 형식의 JSON 객체로만 응답하고 다음 구조를 따른다: {"events":[{"title":"일정 제목","date":"YYYY-MM-DD","startTime":"HH:mm","endTime":"HH:mm","allDay":false,"category":"약속","location":"","notes":""}],"assumptions":[]}. 일정이 없으면 events는 빈 배열이다.`;
  const data = await requestAzureOpenAIJson(systemMessage, `다음 문장을 json 형식의 일정 데이터로 변환해 주세요.\n\n${prompt.trim()}`, 0.2, {
    invalidResponseCode: 'AZURE_OPENAI_INVALID_SCHEDULE',
    invalidResponseMessage: '일정 분석 결과의 형식이 올바르지 않습니다. 문장을 바꿔 다시 분석해 주세요.'
  });
  try {
    return validateExtractedEvents(data);
  } catch {
    throw createAiError(502, '일정 분석 결과의 형식이 올바르지 않습니다. 문장을 바꿔 다시 분석해 주세요.', 'AZURE_OPENAI_INVALID_SCHEDULE');
  }
}

function clockMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatClockMinutes(value) {
  if (!Number.isInteger(value) || value < 0 || value >= 24 * 60) return null;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function cleanPlanCoordinate(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function distanceMeters(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.lat - first.lat);
  const longitudeDelta = radians(second.lng - first.lng);
  const arc = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(first.lat)) * Math.cos(radians(second.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(arc)));
}

function validatePlanInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !isValidDate(body.date) || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 20) {
    throw createAiError(400, '분석할 날짜와 일정 1~20개를 보내 주세요.', 'INVALID_PLAN');
  }
  const mode = ['walk', 'transit', 'car'].includes(body.transportMode) ? body.transportMode : 'transit';
  const ids = new Set();
  const events = body.events.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || typeof event.title !== 'string' || !event.title.trim()
      || (event.date && event.date !== body.date)) {
      throw createAiError(400, '일정 정보가 올바르지 않습니다.', 'INVALID_PLAN_EVENT');
    }
    const allDay = event.allDay === true;
    const startTime = allDay ? '00:00' : event.startTime;
    const endTime = allDay ? '23:59' : event.endTime;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime || '')
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime || '')
      || (!allDay && endTime <= startTime)) {
      throw createAiError(400, '일정 시작·종료 시간이 올바르지 않습니다.', 'INVALID_PLAN_TIME');
    }
    const id = typeof event.id === 'string' && event.id ? event.id.slice(0, 80) : `event-${index + 1}`;
    if (ids.has(id)) throw createAiError(400, '일정 ID가 중복되었습니다.', 'INVALID_PLAN_EVENT');
    ids.add(id);
    const location = typeof event.location === 'string' ? event.location.trim().slice(0, 120) : '';
    const place = cleanPlanCoordinate(event.place);
    return {
      id,
      title: event.title.trim().slice(0, 80),
      date: body.date,
      startTime,
      endTime,
      allDay,
      location,
      place
    };
  });
  return { date: body.date, transportMode: mode, events };
}

function validatePlanResponse(data, plan, transitions) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || typeof data.summary !== 'string' || !data.summary.trim()
    || !Array.isArray(data.transitions) || data.transitions.length !== transitions.length
    || !Array.isArray(data.recommendations) || data.recommendations.length > 5) {
    throw createAiError(502, 'AI 일정 계산 결과의 형식이 올바르지 않습니다. 다시 시도해 주세요.', 'AZURE_OPENAI_INVALID_PLAN');
  }
  const recommendations = data.recommendations.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw createAiError(502, 'AI 일정 계산 결과에 올바르지 않은 제안이 포함되어 있습니다.', 'AZURE_OPENAI_INVALID_PLAN');
    }
    return item.trim().slice(0, 240);
  });
  const checkedTransitions = transitions.map((transition, index) => {
    const result = data.transitions[index];
    if (!result || result.fromId !== transition.fromId || result.toId !== transition.toId
      || (result.travelMinutes !== null && (!Number.isInteger(result.travelMinutes) || result.travelMinutes < 0 || result.travelMinutes > 360))
      || typeof result.reason !== 'string') {
      throw createAiError(502, 'AI 이동 계산 결과의 형식이 올바르지 않습니다. 다시 시도해 주세요.', 'AZURE_OPENAI_INVALID_PLAN');
    }
    const bufferMinutes = result.travelMinutes === null ? null : transition.gapMinutes - result.travelMinutes;
    let status = 'unknown';
    if (transition.gapMinutes < 0) status = 'conflict';
    else if (bufferMinutes !== null) status = bufferMinutes < 0 ? 'tight' : bufferMinutes < 15 ? 'short-buffer' : 'ok';
    const nextEvent = plan.events.find((event) => event.id === transition.toId);
    const recommendedDepartureTime = result.travelMinutes === null
      ? null
      : formatClockMinutes(clockMinutes(nextEvent.startTime) - result.travelMinutes - 10);
    return {
      ...transition,
      travelMinutes: result.travelMinutes,
      bufferMinutes,
      recommendedDepartureTime,
      status,
      reason: result.reason.trim().slice(0, 240)
    };
  });
  const assumptions = Array.isArray(data.assumptions)
    ? data.assumptions.filter((item) => typeof item === 'string').slice(0, 5).map((item) => item.slice(0, 180))
    : [];
  assumptions.push('이동 시간은 Azure OpenAI 추정치이며 실시간 도로·대중교통 정보가 아닙니다.');
  if (transitions.some((item) => item.straightLineDistanceMeters === null)) {
    assumptions.push('좌표가 없는 일정 사이의 이동 시간은 계산하지 않았습니다.');
  }
  return {
    date: plan.date,
    transportMode: plan.transportMode,
    summary: data.summary.trim().slice(0, 300),
    transitions: checkedTransitions,
    recommendations,
    assumptions
  };
}

async function analyzeSchedulePlan(body) {
  const plan = validatePlanInput(body);
  const timedEvents = plan.events.filter((event) => !event.allDay)
    .sort((first, second) => first.startTime.localeCompare(second.startTime));
  const transitions = [];
  for (let index = 0; index < timedEvents.length - 1; index += 1) {
    const previous = timedEvents[index];
    const next = timedEvents[index + 1];
    transitions.push({
      fromId: previous.id,
      fromTitle: previous.title,
      toId: next.id,
      toTitle: next.title,
      nextStartTime: next.startTime,
      gapMinutes: clockMinutes(next.startTime) - clockMinutes(previous.endTime),
      straightLineDistanceMeters: previous.place && next.place ? distanceMeters(previous.place, next.place) : null,
      fromLocation: previous.location,
      toLocation: next.location
    });
  }
  const systemMessage = `너는 실제 일정 자료를 계산하는 한국어 일정 분석기다. 오늘 날짜는 ${getKoreaDate()}이다. 입력은 서버가 검증한 일정과 계산한 정확한 일정 간격 및 좌표가 있을 때의 직선거리다. 입력에 없는 일정, 교통상황, 도로경로, 장소 정보를 지어내지 마라. 직선거리는 실제 도로거리가 아니므로 이동시간은 반드시 추정으로 취급한다. 이동시간 추정은 도보 4.5km/h, 대중교통 도심 20km/h·장거리 70km/h, 자동차 도심 25km/h·장거리 85km/h 기준을 사용하고 도심 우회계수 1.3, 장거리 1.15를 적용한다. 대중교통은 거리가 1.5km를 넘으면 환승·대기 5분을 더한다. 좌표 거리가 null이면 travelMinutes는 반드시 null로 반환한다. gapMinutes에서 이동시간을 뺀 여유가 부족하거나 겹치는 일정을 지적한다. 추천은 주어진 일정 안의 실제 간격만 활용하고 일정을 임의로 변경하지 않는다. 모든 응답은 JSON 객체로만 반환한다: {"summary":"하루 계획 요약","transitions":[{"fromId":"입력 ID","toId":"입력 ID","travelMinutes":20,"reason":"근거"}],"recommendations":["실행 가능한 제안"],"assumptions":["가정"]}. transitions는 입력 transitions와 같은 순서와 ID를 사용하고, 거리 null일 때는 travelMinutes:null로 한다.`;
  const userMessage = `다음 실제 일정 데이터의 시간 간격, 이동 여유, 충돌, 휴식 가능성을 계산해 주세요. JSON으로 응답하세요.\n\n${JSON.stringify({
    date: plan.date,
    transportMode: plan.transportMode,
    events: plan.events.map(({ id, title, startTime, endTime, allDay, location }) => ({ id, title, startTime, endTime, allDay, location })),
    transitions
  })}`;
  const result = await requestAzureOpenAIJson(systemMessage, userMessage, 0.1);
  return validatePlanResponse(result, plan, transitions);
}

module.exports = {
  getAiStatus,
  parseSchedulePrompt,
  analyzeSchedulePlan
};
