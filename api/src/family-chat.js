const crypto = require('node:crypto');

const MAX_MESSAGES = 200;
const MAX_MESSAGE_LENGTH = 1000;

function createFamilyChat({ store, now, FamilyError }) {
  const partitionFor = (context) => `family:${context.family.id}`;

  async function list(context) {
    const records = await store.list(partitionFor(context), 'message_');
    return { messages: records.slice(-MAX_MESSAGES).map(({ value }) => value) };
  }

  async function send(context, body) {
    if (typeof body.text !== 'string' || !body.text.trim()
      || body.text.length > MAX_MESSAGE_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) {
      throw new FamilyError(400, '메시지는 공백이 아닌 1~1,000자로 입력해 주세요.', 'INVALID_MESSAGE');
    }
    const timestamp = now();
    const message = {
      id: `${String(timestamp).padStart(13, '0')}_${crypto.randomUUID()}`,
      senderId: context.member.id,
      senderName: context.member.name,
      text: body.text.trim(),
      createdAt: new Date(timestamp).toISOString()
    };
    const partition = partitionFor(context);
    await store.put(partition, `message_${message.id}`, message);
    const records = await store.list(partition, 'message_');
    await Promise.all(records.slice(0, Math.max(0, records.length - MAX_MESSAGES))
      .map(({ row }) => store.remove(partition, row)));
    return { message };
  }

  return { list, send };
}

module.exports = { createFamilyChat, MAX_MESSAGES, MAX_MESSAGE_LENGTH };
