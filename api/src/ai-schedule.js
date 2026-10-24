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

async function parseSchedulePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
    throw createAiError(400, '일정 문장을 1~4,000자 사이로 입력해 주세요.', 'INVALID_PROMPT');
  }

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

  const systemMessage = `너는 한국어 일정 문장을 캘린더 일정으로 변환하는 도우미다. 기준 날짜는 한국 시간 오늘 ${getKoreaDate()}이다. 상대 날짜(오늘, 내일, 모레, 이번 주 금요일 등)는 이 기준으로 계산한다. 사용자가 명시한 일정만 분리하고, 최대 20개까지 반환한다. 시간이 없으면 오전 9시 시작, 1시간 일정으로 설정하고 assumptions에 그 가정을 알린다. 종료 시간이 없으면 시작 시간부터 1시간으로 설정한다. 종일 여부가 명확할 때만 allDay를 true로 한다. category는 약속, 업무, 운동, 개인, 기타 중 하나다. 모든 문자열은 한국어로 작성한다. 반드시 json 형식의 JSON 객체로만 응답하고 다음 구조를 따른다: {"events":[{"title":"일정 제목","date":"YYYY-MM-DD","startTime":"HH:mm","endTime":"HH:mm","allDay":false,"category":"약속","location":"","notes":""}],"assumptions":[]}. 일정이 없으면 events는 빈 배열이다.`;
  const requestBody = apiMode === 'responses'
    ? {
      model: process.env.AZURE_OPENAI_DEPLOYMENT,
      instructions: systemMessage,
      input: `다음 문장을 json 형식의 일정 데이터로 변환해 주세요.\n\n${prompt.trim()}`,
      text: { format: { type: 'json_object' } }
    }
    : {
      model: process.env.AZURE_OPENAI_DEPLOYMENT,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: prompt.trim() }
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
  const content = apiMode === 'responses'
    ? completion.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text
      || completion.output_text
    : completion.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw createAiError(502, 'Azure OpenAI 응답에서 일정 내용을 찾지 못했습니다.', 'AZURE_OPENAI_EMPTY_RESPONSE');
  }
  try {
    return validateExtractedEvents(JSON.parse(content));
  } catch {
    throw createAiError(502, '일정 분석 결과의 형식이 올바르지 않습니다. 문장을 바꿔 다시 분석해 주세요.', 'AZURE_OPENAI_INVALID_SCHEDULE');
  }
}

module.exports = {
  getAiStatus,
  parseSchedulePrompt
};
