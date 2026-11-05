const { distanceMeters, estimateTravel } = require('./route-estimate');

// Static Web Apps 게이트웨이가 약 45초에 요청을 끊으므로 그 전에 안내 가능한 오류로 끝낸다.
const AI_TIMEOUT_MS = 30_000;
const AI_NARRATIVE_TIMEOUT_MS = 20_000;

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

function getKoreaDateWithWeekday() {
  const date = getKoreaDate();
  const weekday = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'long' }).format(new Date());
  return `${date} (${weekday})`;
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
  let adjusted = false;
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
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.startTime)) {
      throw new Error('AI returned an invalid event time.');
    }
    let endTime = event.endTime;
    let startTime = event.startTime;
    if (typeof endTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) || endTime <= startTime) {
      // 자정을 넘기거나 종료 시간이 없는 일정은 같은 날 안에서 1시간(최대 23:59)으로 보정한다.
      let endMinutes = Math.min(clockMinutes(startTime) + 60, 23 * 60 + 59);
      if (endMinutes <= clockMinutes(startTime)) {
        startTime = '23:58';
        endMinutes = 23 * 60 + 59;
      }
      endTime = formatClockMinutes(endMinutes);
      adjusted = true;
    }
    return {
      title: event.title.trim().slice(0, 80),
      date: event.date,
      startTime,
      endTime,
      allDay: false,
      category: event.category,
      location: event.location.trim().slice(0, 120),
      notes: event.notes.trim().slice(0, 300)
    };
  });
  const assumptions = Array.isArray(data.assumptions)
    ? data.assumptions.filter((item) => typeof item === 'string').slice(0, 10)
    : [];
  if (adjusted) assumptions.push('종료 시간이 없거나 시작 시간보다 빠른 일정은 시작 1시간 뒤(최대 23:59)로 맞췄어요. 등록 전에 시간을 확인해 주세요.');
  return { events, assumptions };
}

async function requestAzureOpenAIJson(systemMessage, userMessage, temperature = 0.2, {
  invalidResponseCode = 'AZURE_OPENAI_INVALID_RESPONSE',
  invalidResponseMessage = 'Azure OpenAI가 올바른 구조의 JSON을 반환하지 않았습니다.',
  timeoutMs = AI_TIMEOUT_MS
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
      signal: AbortSignal.timeout(timeoutMs)
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
  const systemMessage = `너는 한국어 일정 문장을 캘린더 일정으로 변환하는 도우미다. 기준 날짜는 한국 시간 오늘 ${getKoreaDateWithWeekday()}이다. 상대 날짜(오늘, 내일, 모레, 이번 주 금요일, 다음 주 월요일 등)는 이 기준으로 계산한다. 일정은 하루 안에서 끝나야 하며 자정을 넘기면 종료를 23:59로 한다. 장소가 문장에 있으면 location에 장소명만 넣는다. 사용자가 명시한 일정만 분리하고, 최대 20개까지 반환한다. 시간이 없으면 오전 9시 시작, 1시간 일정으로 설정하고 assumptions에 그 가정을 알린다. 종료 시간이 없으면 시작 시간부터 1시간으로 설정한다. 종일 여부가 명확할 때만 allDay를 true로 한다. category는 약속, 업무, 운동, 개인, 기타 중 하나다. 모든 문자열은 한국어로 작성한다. 반드시 json 형식의 JSON 객체로만 응답하고 다음 구조를 따른다: {"events":[{"title":"일정 제목","date":"YYYY-MM-DD","startTime":"HH:mm","endTime":"HH:mm","allDay":false,"category":"약속","location":"","notes":""}],"assumptions":[]}. 일정이 없으면 events는 빈 배열이다.`;
  const userMessage = `다음 문장을 json 형식의 일정 데이터로 변환해 주세요.\n\n${prompt.trim()}`;
  const invalidScheduleError = () => createAiError(502, '일정 분석 결과의 형식이 올바르지 않습니다. 문장을 바꿔 다시 분석해 주세요.', 'AZURE_OPENAI_INVALID_SCHEDULE');
  // 형식 오류는 즉시 돌아오므로 한 번만 다시 시도한다. 시간 초과·연결 오류는 재시도하지 않는다.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const data = await requestAzureOpenAIJson(systemMessage, userMessage, 0.2, {
        invalidResponseCode: 'AZURE_OPENAI_INVALID_SCHEDULE',
        invalidResponseMessage: invalidScheduleError().message
      });
      try {
        return validateExtractedEvents(data);
      } catch {
        throw invalidScheduleError();
      }
    } catch (error) {
      if (attempt >= 2 || error.code !== 'AZURE_OPENAI_INVALID_SCHEDULE') throw error;
    }
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

function planStatus(gapMinutes, bufferMinutes) {
  if (gapMinutes < 0) return 'conflict';
  if (bufferMinutes === null) return 'unknown';
  return bufferMinutes < 0 ? 'tight' : bufferMinutes < 15 ? 'short-buffer' : 'ok';
}

function summarizePlanLocally(plan, transitions) {
  const timedCount = plan.events.filter((event) => !event.allDay).length;
  if (!transitions.length) {
    return `시간이 정해진 일정이 ${timedCount}개예요. 일정이 2개 이상이면 일정 사이 이동 여유를 계산해 드려요.`;
  }
  const count = (status) => transitions.filter((item) => item.status === status).length;
  const risky = count('conflict') + count('tight');
  if (risky) return `일정 사이 ${transitions.length}곳 중 ${risky}곳이 겹치거나 이동 시간이 부족해요.`;
  if (count('short-buffer')) return `일정 사이 ${transitions.length}곳 중 ${count('short-buffer')}곳은 이동 후 여유가 15분 미만이에요.`;
  if (count('unknown') === transitions.length) return '장소 위치가 없어 이동 시간은 계산하지 못했어요. 일정 장소를 검색해 선택해 주세요.';
  return `일정 사이 ${transitions.length}곳 모두 이동할 시간이 충분해요.`;
}

function recommendPlanLocally(transitions) {
  const items = [];
  for (const item of transitions) {
    if (item.status === 'conflict') {
      items.push(`'${item.fromTitle}'와 '${item.toTitle}' 일정이 ${Math.abs(item.gapMinutes)}분 겹쳐요. 한쪽 시간을 조정해 주세요.`);
    } else if (item.status === 'tight') {
      items.push(`'${item.toTitle}'까지 이동에 약 ${item.travelMinutes}분이 필요해 ${Math.abs(item.bufferMinutes)}분 부족해요. 시작 시간을 늦추거나 '${item.fromTitle}'을 일찍 마치세요.`);
    } else if (item.status === 'short-buffer') {
      items.push(`'${item.toTitle}'까지 여유가 ${item.bufferMinutes}분뿐이에요. ${item.recommendedDepartureTime ? `${item.recommendedDepartureTime}에는 출발하세요.` : '서둘러 출발하세요.'}`);
    }
  }
  if (transitions.some((item) => item.status === 'unknown')) {
    items.push('장소를 검색해 선택하면 일정 사이 이동 시간을 계산할 수 있어요.');
  }
  return items.slice(0, 5);
}

function validatePlanNarrative(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || typeof data.summary !== 'string' || !data.summary.trim()
    || !Array.isArray(data.recommendations) || data.recommendations.length > 5
    || data.recommendations.some((item) => typeof item !== 'string' || !item.trim())) {
    throw createAiError(502, 'AI 일정 요약의 형식이 올바르지 않습니다.', 'AZURE_OPENAI_INVALID_PLAN');
  }
  return {
    summary: data.summary.trim().slice(0, 300),
    recommendations: data.recommendations.map((item) => item.trim().slice(0, 240)),
    assumptions: Array.isArray(data.assumptions)
      ? data.assumptions.filter((item) => typeof item === 'string').slice(0, 3).map((item) => item.slice(0, 180))
      : []
  };
}

async function requestPlanNarrative(plan, transitions) {
  const systemMessage = `너는 한국어 일정 코치다. 오늘 날짜는 ${getKoreaDateWithWeekday()}이다. 입력의 일정과 transitions는 서버가 이미 계산한 정확한 값이다. 숫자(이동시간, 여유, 출발 시각)를 바꾸거나 입력에 없는 일정·장소·교통상황을 지어내지 마라. 일정을 임의로 변경하지 말고, 겹침·이동 시간 부족·여유 부족을 우선해 사용자가 바로 할 행동을 짧게 제안한다. 반드시 json 형식의 JSON 객체로만 응답한다: {"summary":"하루 계획 한두 문장 요약","recommendations":["실행 가능한 제안"],"assumptions":[]}. recommendations는 최대 5개다.`;
  const userMessage = `다음 계산 결과를 요약하고 제안해 주세요. JSON으로 응답하세요.\n\n${JSON.stringify({
    date: plan.date,
    transportMode: plan.transportMode,
    events: plan.events.map(({ id, title, startTime, endTime, allDay, location }) => ({ id, title, startTime, endTime, allDay, location })),
    transitions: transitions.map(({ fromTitle, toTitle, gapMinutes, travelMinutes, bufferMinutes, recommendedDepartureTime, status, reason }) => ({ fromTitle, toTitle, gapMinutes, travelMinutes, bufferMinutes, recommendedDepartureTime, status, reason }))
  })}`;
  return validatePlanNarrative(await requestAzureOpenAIJson(systemMessage, userMessage, 0.3, {
    invalidResponseCode: 'AZURE_OPENAI_INVALID_PLAN',
    invalidResponseMessage: 'AI 일정 요약의 형식이 올바르지 않습니다.',
    timeoutMs: AI_NARRATIVE_TIMEOUT_MS
  }));
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
  const travels = await Promise.all(transitions.map((transition, index) => {
    const from = timedEvents[index].place;
    const to = timedEvents[index + 1].place;
    return from && to ? estimateTravel(from, to, plan.transportMode) : null;
  }));
  const checkedTransitions = transitions.map((transition, index) => {
    const travel = travels[index];
    const travelMinutes = travel ? travel.travelMinutes : null;
    const bufferMinutes = travelMinutes === null ? null : transition.gapMinutes - travelMinutes;
    return {
      ...transition,
      travelMinutes,
      bufferMinutes,
      recommendedDepartureTime: travelMinutes === null
        ? null
        : formatClockMinutes(clockMinutes(transition.nextStartTime) - travelMinutes - 10),
      status: planStatus(transition.gapMinutes, bufferMinutes),
      routeSource: travel ? travel.method : null,
      reason: travel ? travel.detail : '일정 장소의 위치가 없어 이동 시간을 계산하지 않았어요.'
    };
  });

  const assumptions = [];
  if (checkedTransitions.some((item) => item.routeSource === 'estimate')) {
    assumptions.push('이동 시간은 직선거리 기반 추정이며 실시간 도로·대중교통 정보가 아니에요.');
  }
  if (checkedTransitions.some((item) => item.status === 'unknown')) {
    assumptions.push('위치가 없는 일정 사이의 이동 시간은 계산하지 않았어요.');
  }
  let summary = summarizePlanLocally(plan, checkedTransitions);
  let recommendations = recommendPlanLocally(checkedTransitions);
  let aiNotice = null;
  let aiSummary = false;
  if (checkedTransitions.length && getAiStatus().configured) {
    try {
      const narrative = await requestPlanNarrative(plan, checkedTransitions);
      summary = narrative.summary;
      recommendations = narrative.recommendations;
      assumptions.push(...narrative.assumptions);
      aiSummary = true;
    } catch (error) {
      // 이동 계산은 이미 끝났으므로 AI 요약 실패는 기본 요약으로 대체한다.
      console.error(`AI plan summary unavailable (${error.code || 'UNKNOWN'}).`);
      aiNotice = 'AI 요약을 불러오지 못해 기본 계산 결과만 표시해요.';
    }
  }
  return {
    date: plan.date,
    transportMode: plan.transportMode,
    summary,
    transitions: checkedTransitions,
    recommendations,
    assumptions,
    aiSummary,
    aiNotice
  };
}

module.exports = {
  getAiStatus,
  parseSchedulePrompt,
  analyzeSchedulePlan
};
