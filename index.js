// На Render переменные уже в process.env; dotenv не перезаписывает их (override: false).
require('dotenv').config({ override: false });

const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ===================== Утилиты окружения =====================

function cleanEnvVar(val) {
  if (!val) return '';
  return String(val).trim().replace(/^["']|["']$/g, '');
}

function cleanBotToken(val) {
  if (!val) return '';
  let token = String(val).trim().replace(/^\uFEFF/, '');
  token = token.replace(/^bot\s*/i, '').replace(/^token[:\s]*/i, '');
  token = token.replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  return token;
}

function readEnvConfig() {
  return {
    botToken: cleanBotToken(process.env.TELEGRAM_BOT_TOKEN),
    groqApiKey: cleanEnvVar(process.env.GROQ_API_KEY),
    googleScriptUrl: cleanEnvVar(process.env.GOOGLE_SCRIPT_URL)
  };
}

let { botToken, groqApiKey, googleScriptUrl } = readEnvConfig();
let activeBotToken = '';

const TOKEN_FORMAT = /^\d+:[A-Za-z0-9_-]{20,}$/;

function logTokenDiagnostics(token) {
  const botId = token.includes(':') ? token.split(':')[0] : '???';
  console.log(`🔑 TELEGRAM_BOT_TOKEN: bot_id=${botId}, длина=${token.length}, Render=${!!process.env.RENDER}`);
}

function validateEnvConfig(config) {
  const missing = [];
  if (!config.botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.groqApiKey) missing.push('GROQ_API_KEY');
  if (!config.googleScriptUrl) missing.push('GOOGLE_SCRIPT_URL');

  if (missing.length > 0) {
    console.error('❌ Не заданы переменные окружения:', missing.join(', '));
    console.error('   Локально: добавь их в файл .env');
    console.error('   Render: Dashboard → Environment → Environment Variables');
    console.error('   Если есть Secret File (.env) — обнови и Environment Variable (она важнее).');
    return false;
  }

  if (!TOKEN_FORMAT.test(config.botToken)) {
    console.error('❌ TELEGRAM_BOT_TOKEN имеет неверный формат.');
    console.error('   Нужен вид: 123456789:ABCdefGHI... (только токен, без "bot" и кавычек).');
    logTokenDiagnostics(config.botToken);
    return false;
  }

  return true;
}

// Health-check для Render (поднимаем сразу, независимо от бота)
const port = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kaban Financier is alive!');
}).listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

// ===================== Курсы валют (персист в файл) =====================

const RATES_FILE = path.join(__dirname, 'rates.json');
let rates = { VND: 330, THB: 0.38 };

function loadRates() {
  try {
    if (fs.existsSync(RATES_FILE)) {
      rates = JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'));
      console.log('Курсы загружены:', rates);
    } else {
      saveRates();
    }
  } catch (err) {
    console.error('Ошибка чтения rates.json:', err.message);
  }
}

function saveRates() {
  try {
    fs.writeFileSync(RATES_FILE, JSON.stringify(rates, null, 2), 'utf8');
  } catch (err) {
    console.error('Ошибка сохранения rates.json:', err.message);
  }
}

loadRates();

// ===================== Состояние пользователей (тоже персист) =====================

const STATE_FILE = path.join(__dirname, 'state.json');
let userCurrencies = {};
let userStates = {};
const pendingDeletions = new Set();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      userCurrencies = saved.userCurrencies || {};
      userStates = saved.userStates || {};
      console.log('Состояние пользователей загружено');
    }
  } catch (err) {
    console.error('Ошибка чтения state.json:', err.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ userCurrencies, userStates }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('Ошибка сохранения state.json:', err.message);
  }
}

loadState();

// ===================== Инициализация бота =====================

let bot = null;

// Безопасная отправка сообщений
async function safeSendMessage(chatId, text, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await bot.sendMessage(chatId, text, options);
    } catch (err) {
      if ((err.code === 'EFATAL' || err.code === 'ETIMEDOUT') && i < retries - 1) {
        await new Promise((res) => setTimeout(res, 1000));
      } else if (err.message && err.message.includes('PARSE_MODE') && options.parse_mode) {
        delete options.parse_mode;
        return await bot.sendMessage(chatId, text, options);
      } else {
        console.error('safeSendMessage не смог отправить сообщение:', err.message);
        throw err;
      }
    }
  }
}

// ===================== Парсер JSON от нейросетей =====================
// ВАЖНО: проверь этот блок в своём реальном файле. В коде, который ты
// прислал в чат, здесь стояло:
//   if (out.includes('')) { out = out.split('').pop(); }
// Пустая строка '' входит в ЛЮБУЮ строку, поэтому эта ветка срабатывала
// ВСЕГДА, а out.split('').pop() разбивал ответ модели по каждому символу
// и оставлял только последний символ — то есть весь JSON от нейросети
// обрезался до одной буквы. Похоже, при копировании в чат теги <think> и
// </think> (как обычный текст) были съедены разметкой мессенджера. Если в
// твоём исходнике реально стоит out.includes('') — это отдельный
// серьёзный баг, вот рабочая версия с явными тегами:
function stripThinkTags(text) {
  let out = (text || '').trim();
  if (out.includes('<think>')) {
    out = out.split('<think>').pop();
  }
  out = out
    .replace(/[\s\S]*?<\/think>/gi, '')
    .replace(/[\s\S]*?<\/redacted_thinking>/gi, '')
    .trim();
  return out;
}

// Вытаскивает полностью сформированные позиции из обрезанного JSON (длинные чеки).
function salvageReceiptItems(rawText) {
  const text = stripThinkTags(rawText);
  const items = [];
  const re = /\{\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"price"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*"category"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"type"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    items.push({
      name: match[1].replace(/\\"/g, '"'),
      price: Number(match[2]),
      category: match[3],
      type: match[4]
    });
  }
  return items.length > 0 ? { items } : null;
}

function cleanAndParseJSON(rawText) {
  let text = stripThinkTags(rawText);
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();

  if (!text) {
    throw new Error('Пустой ответ от нейросети');
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    text = text.substring(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    console.log('⚠️ Применяется доп. очистка кавычек и переносов...');
    const sanitized = text
      .replace(/\r?\n/g, ' ')
      .replace(/([{,]\s*"[a-zA-Z0-9_]+"\s*:\s*)"([^"]*)"/g, (match, p1, p2) => {
        return p1 + '"' + p2.replace(/"/g, "'") + '"';
      });

    return JSON.parse(sanitized);
  }
}

function parseReceiptJSON(rawText) {
  try {
    return cleanAndParseJSON(rawText);
  } catch (err) {
    const salvaged = salvageReceiptItems(rawText);
    if (salvaged) {
      console.log(`✅ Восстановлено ${salvaged.items.length} позиций из обрезанного ответа Groq`);
      return salvaged;
    }
    throw err;
  }
}

// ===================== Единая точка вызова Groq =====================

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function callGroq({ model, system, userContent, temperature, maxTokens, timeout = 20000, extra = {}, retries = 2 }) {
  if (!groqApiKey) {
    throw new Error('GROQ_API_KEY не задан в переменных окружения');
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent });

  const payload = { model, messages, ...extra };
  if (temperature !== undefined) payload.temperature = temperature;
  if (maxTokens !== undefined) payload.max_tokens = maxTokens;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(GROQ_CHAT_URL, payload, {
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout
      });

      const choice = response.data?.choices?.[0];
      if (choice?.finish_reason === 'length' && !choice?.message?.content) {
        console.warn(`⚠️ Groq (${model}) исчерпал max_tokens на скрытых рассуждениях, content пуст. Увеличь maxTokens или снизь reasoning_effort.`);
      }

      return choice?.message?.content;
    } catch (err) {
      // 429 = упёрлись в TPM/RPM лимит free-тарифа. Groq обычно отдаёт
      // Retry-After, а если нет — ждём с запасом и пробуем ещё раз, не
      // падая в ошибку пользователю на ровном месте.
      if (err.response?.status === 429 && attempt < retries) {
        const retryAfterSec = Number(err.response.headers?.['retry-after']) || 2;
        console.warn(`⚠️ Groq 429 (${model}), попытка ${attempt + 1}/${retries}, жду ${retryAfterSec}с...`);
        await new Promise((res) => setTimeout(res, retryAfterSec * 1000));
        continue;
      }
      throw err;
    }
  }
}

// ===================== Общие справочники =====================

const CATEGORIES = [
  'Продукты', 'Бухло', 'Вкусняшки кабаньи', 'Транспорт',
  'Жилье и Коммуналка', 'Развлечения и Отдых', 'Здоровье и Аптека',
  'Покупки и Шмотки', 'Кафе и Рестораны', 'Подарки и Донаты'
];
const EXPENSE_TYPES = ['Личный', 'Общий'];

// ⚠️ ГЛАВНЫЙ ФИКС ⚠️
// llama-3.3-70b-versatile была объявлена deprecated Groq 17 июня 2026 и
// ПОЛНОСТЬЮ ОТКЛЮЧЕНА 16 августа 2026 — все запросы к ней падают с
// ошибкой model_decommissioned. Именно поэтому текстовые траты
// ("пиво 400") и аналитика перестали работать: callGroq кидал ошибку,
// она ловилась в catch, и бот просто отвечал "напиши в формате...", не
// заводя трату. Фото при этом продолжали работать, т.к. используют
// другую модель (qwen/qwen3.6-27b), которую Groq не трогала.
//
// Модель: openai/gpt-oss-20b — лёгкая (быстрее и "дешевле" по токенам,
// чем 120b), это официальная рекомендованная Groq замена для другой
// снятой модели (llama-3.1-8b-instant), и её более чем достаточно для
// простой задачи "вытащи сумму/категорию из короткой фразы". Тоже
// бесплатный тариф, как и всё остальное в проекте.
// Вынесено в константу, чтобы при следующем депрекейшене менять модель
// в одном месте.
const GROQ_TEXT_MODEL = 'openai/gpt-oss-20b';

// Слова, для которых нужно сработать "фикс" завышенной цены с чека
// (модель иногда путает разряды и возвращает 1 500 000 вместо 15 000).
const SMALL_ITEM_WORDS = ['вода', 'кофе', 'чай', 'чипсы', 'пиво'];

function isSmallItem(name) {
  const words = (name || '').toLowerCase().split(/[^а-яёa-z0-9]+/i).filter(Boolean);
  return words.some((w) => SMALL_ITEM_WORDS.includes(w));
}

const USERS = {
  336595543: 'Главный кабан',
  333816615: 'Кабанка'
};

// ===================== Удаление траты =====================

async function handleDeleteExpense(chatId, userId, messageIdToDelete = null) {
  if (!googleScriptUrl || !googleScriptUrl.startsWith('http')) {
    if (messageIdToDelete) pendingDeletions.delete(messageIdToDelete);
    return safeSendMessage(chatId, '🐗 Некорректный GOOGLE_SCRIPT_URL!');
  }

  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || '';

  try {
    await axios.post(googleScriptUrl, {
      action: messageIdToDelete ? 'delete_by_id' : 'delete_last',
      telegramId: userId,
      user: kabanName,
      messageId: messageIdToDelete
    }, { timeout: 12000 });

    if (messageIdToDelete) {
      try {
        await bot.editMessageText('❌ *Трата отменена и удалена из таблицы!*', {
          chat_id: chatId,
          message_id: messageIdToDelete,
          parse_mode: 'Markdown'
        });
      } catch (e) {
        console.error('Не удалось отредактировать сообщение при удалении:', e.message);
      }
    } else {
      await safeSendMessage(chatId, '🗑 *Последняя трата удалена из таблицы!*', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('Ошибка удаления траты в Google Таблице:', err.message);
    if (messageIdToDelete) {
      try {
        await bot.editMessageText('❌ *Эта трата отменена.*', {
          chat_id: chatId,
          message_id: messageIdToDelete,
          parse_mode: 'Markdown'
        });
      } catch (e) {
        console.error('Не удалось отредактировать сообщение после ошибки удаления:', e.message);
      }
    } else {
      await safeSendMessage(chatId, '🗑 *Твой запрос на удаление обработан!*', { parse_mode: 'Markdown' });
    }
  } finally {
    if (messageIdToDelete) pendingDeletions.delete(messageIdToDelete);
  }
}

function sendMainMenu(chatId) {
  return safeSendMessage(chatId, "🐗 Хрю! Я Кабан-финансист!\nВыбирай валюту и заноси траты:", {
    reply_markup: {
      keyboard: [
        [{ text: "💱 Валюта" }, { text: "📊 Статистика" }],
        [{ text: "⚙️ Изменить курс" }, { text: "🗑 Удалить последнюю" }]
      ],
      resize_keyboard: true
    }
  });
}

// ===================== Запись траты =====================

async function processExpense(msg, data) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || 'Главный кабан';
  const currentCurr = userCurrencies[chatId] || 'VND';

  const rawAmount = Number(data.amount);

  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    await safeSendMessage(
      chatId,
      `🐗 Не смог разобрать сумму для "${data.description || 'позиции'}" — пропускаю её.`
    );
    return;
  }

  let amountRub = rawAmount;
  if (currentCurr === 'VND') {
    amountRub = rawAmount / (rates.VND || 330);
  } else if (currentCurr === 'THB') {
    amountRub = rawAmount / (rates.THB || 0.38);
  }

  const currencySymbols = { RUB: '₽', VND: '₫', THB: '฿' };

  let greetingHeader = '';
  if (kabanName === 'Главный кабан') {
    const headers = [
      '🐗🫡 *Служу Главному Кабану! Трата зафиксирована!*',
      '🐗🫡 *Слушаюсь, Дон Кабаньоне! Желуди сосчитаны!*',
      '🐗🫡 *Вожак Стада, трата занесена в реестр!*'
    ];
    greetingHeader = headers[Math.floor(Math.random() * headers.length)];
  } else if (kabanName === 'Кабанка') {
    const headers = [
      '🐗🙇‍♂️ *Моё почтение, Кабанка! С уважением занёс трату!*',
      '🐗🙇‍♂️ *Прекрасная Кабанка, трата внесена без промедлений!*',
      '🐗🙇‍♂️ *Повелительница Желудей, данные в дубраве!*'
    ];
    greetingHeader = headers[Math.floor(Math.random() * headers.length)];
  } else {
    greetingHeader = '🐗 *Хрю! Трата занесена!*';
  }

  const textMessage =
    `${greetingHeader}\n\n` +
    `💸 *Сумма:* ${amountRub.toFixed(2)} ₽${currentCurr !== 'RUB' ? ` (${Math.round(rawAmount).toLocaleString('ru-RU')} ${currentCurr}${currencySymbols[currentCurr] || ''})` : ''}\n` +
    `📂 *Категория:* ${data.category}\n` +
    `📝 *Описание:* ${data.description || 'без описания'}\n` +
    `🏷 *Тип:* ${data.type || 'Общий'}\n\n` +
    `📊 _Зарубил на носу и отправляю в дубраву (таблицу)!_`;

  const sentMsg = await safeSendMessage(chatId, textMessage, { parse_mode: 'Markdown' });
  if (!sentMsg) return;

  const sentMessageId = sentMsg.message_id;

  try {
    await bot.editMessageReplyMarkup({
      inline_keyboard: [
        [{ text: '🗑 Отменить эту трату', callback_data: `DELETE_MSG_${sentMessageId}` }]
      ]
    }, {
      chat_id: chatId,
      message_id: sentMessageId
    });
  } catch (e) {
    console.error('Не удалось добавить кнопку отмены:', e.message);
  }

  if (googleScriptUrl && googleScriptUrl.startsWith('http')) {
    try {
      await axios.post(googleScriptUrl, {
        action: 'add',
        telegramId: userId,
        user: kabanName,
        amountRub: amountRub,
        category: data.category,
        name: data.description || '',
        type: data.type || 'Общий',
        messageId: sentMessageId
      }, { timeout: 15000 });
      console.log('--- УСПЕШНО ОТПРАВЛЕНО В GOOGLE ТАБЛИЦЫ ---');
    } catch (err) {
      console.error('Ошибка записи в Google Таблицу:', err.message);
    }
  }
}

// ===================== Аналитика =====================

async function handleAnalytics(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || 'Главный кабан';

  await safeSendMessage(chatId, '🐗 *Кабан роет в таблицах и считает желуди... Секундочку!*', { parse_mode: 'Markdown' });

  if (!googleScriptUrl || !googleScriptUrl.startsWith('http')) {
    return safeSendMessage(chatId, '🐗 Некорректный GOOGLE_SCRIPT_URL!');
  }

  try {
    const tableDataResponse = await axios.get(googleScriptUrl, { timeout: 15000 });
    const historyData = tableDataResponse.data;

    const rawAnswer = await callGroq({
      model: GROQ_TEXT_MODEL, // было: 'llama-3.3-70b-versatile' — отключена Groq 16.08.2026
      maxTokens: 6144, // было 4096 — с запасом, чтобы скрытые рассуждения не съели весь лимит на большой истории трат
      timeout: 30000,
      extra: { reasoning_format: 'hidden' }, // здесь рассуждение оставляем как есть — для аналитики оно уместно, просто не показываем его
      system: `Ты — харизматичный финансовый аналитик "Кабан Финансист". Пользователь: "${kabanName}".
История трат в JSON: ${JSON.stringify(historyData)}.

ПРАВИЛА:
1. НИКОГДА НЕ ИСПОЛЬЗУЙ РЕШЁТКИ (#, ##) для заголовков!
2. Для заголовков используй ЭМОДЗИ + ЖИРНЫЙ ТЕКСТ.
3. Пиши с кабанским юмором.`,
      userContent: msg.text || 'Покажи аналитику трат'
    });

    const aiAnalyticsAnswer = stripThinkTags(rawAnswer);

    return await safeSendMessage(chatId, aiAnalyticsAnswer, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Ошибка аналитики:', error.message);
    await safeSendMessage(chatId, '🐗 Упс! Кабан не смог прочесть аналитику.');
  }
}

function registerBotHandlers() {
  bot.on('polling_error', (error) => {
    const msg = error.message || String(error);
    if (msg.includes('401') || msg.includes('Unauthorized')) {
      console.error('❌ 401 Unauthorized при polling — Telegram отклонил токен.');
      logTokenDiagnostics(activeBotToken);
      console.error('   Проверь Environment Variables (не Secret File) на Render.');
      bot.stopPolling().catch(() => {});
      return;
    }
    console.error(`[Polling Error]: ${msg}`);
  });

  // ===================== Обработка фото (чеков) =====================

  bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;

  try {
    await bot.sendChatAction(chatId, 'typing');
  } catch (e) {
    console.error('sendChatAction упал:', e.message);
  }

  try {
    if (!msg.photo || !Array.isArray(msg.photo) || msg.photo.length === 0) {
      return safeSendMessage(chatId, '🐗 Ошибка: Telegram не передал массив фото.');
    }

    // Берем самое крупное фото
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    if (!fileId || typeof fileId !== 'string') {
      console.error('❌ file_id не является строкой!', photo);
      return safeSendMessage(chatId, '🐗 Ошибка: Некорректный ID файла от Telegram.');
    }

    if (!activeBotToken) {
      return safeSendMessage(chatId, '🐗 Ошибка: Не задан TELEGRAM_BOT_TOKEN в переменных!');
    }

    // 1. Получаем путь к файлу напрямую через Telegram API
    const getFileApiUrl = `https://api.telegram.org/bot${activeBotToken}/getFile?file_id=${encodeURIComponent(fileId)}`;

    const fileRes = await fetch(getFileApiUrl);
    const fileData = await fileRes.json();

    if (!fileData.ok || !fileData.result || !fileData.result.file_path) {
      console.error('❌ Ошибка ответа Telegram getFile:', fileData);
      return safeSendMessage(chatId, '🐗 Telegram не отдал путь к файлу чека.');
    }

    const cleanFilePath = String(fileData.result.file_path).trim();
    const downloadUrl = `https://api.telegram.org/file/bot${activeBotToken}/${cleanFilePath}`;

    // 2. Скачиваем файл
    const imageResponse = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    // 3. Оптимизация через sharp
    const compressedBuffer = await sharp(imageResponse.data)
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const base64Image = compressedBuffer.toString('base64');
    const captionText = msg.caption ? `Подпись к чеку: "${msg.caption}"` : 'Без подписи.';

    // 4. Запрос к Groq Vision (qwen3.6-27b — держим её осознанно, т.к.
    // это бесплатный тариф Groq; при желании потом можно добавить fallback
    // на другую модель, если эта станет недоступна).
    const rawContent = await callGroq({
      model: 'qwen/qwen3.6-27b',
      temperature: 0.1,
      // На free-тарифе у qwen/qwen3.6-27b лимит 8000 ТОКЕНОВ В МИНУТУ, и
      // Groq резервирует под запрос весь maxTokens ЗАРАНЕЕ, ещё до
      // генерации ответа. Само фото уже "стоит" ~2000-3000 токенов
      // (фиксированные 2048 за картинку + системный промпт), поэтому
      // maxTokens здесь должен быть скромным, иначе 429 прилетает даже
      // при полностью свободном лимите. С reasoning_effort: 'none'
      // (см. ниже) реального текста в ответе немного — 2500 с большим
      // запасом хватает на чек с кучей позиций.
      maxTokens: 2500,
      timeout: 60000,
      // reasoning_effort: 'none' отключает режим "размышлений" у Qwen —
      // задача "распознай и переведи позиции с чека" не требует глубокого
      // рассуждения, а скрытые рассуждения съедали токены на чеках с
      // несколькими позициями, оставляя content пустым.
      extra: { reasoning_format: 'hidden', reasoning_effort: 'none' },
      system: `Ты модуль распознавания чеков. Выдели ВСЕ товары и цены.
ОБЯЗАТЕЛЬНО ПЕРЕВОДИ все названия товаров на РУССКИЙ ЯЗЫК (например: "Thịt heo" -> "Свинина", "Cà phê" -> "Кофе", "Water" -> "Вода", "Bánh mì" -> "Хлеб").

Верни СТРОГО валидный JSON-объект без пояснений.

ВНИМАНИЕ: В названиях товаров НЕ используй двойные кавычки.

ФОРМАТ JSON:
{
  "items": [
    {
      "name": "Название товара на русском",
      "price": 50000,
      "category": "Продукты",
      "type": "Общий"
    }
  ]
}

Категории: ${CATEGORIES.join(', ')}.
Тип: "${EXPENSE_TYPES.join('" или "')}".`,
      userContent: [
        { type: 'text', text: captionText },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${base64Image}` }
        }
      ]
    });

    let data = parseReceiptJSON(rawContent); // было cleanAndParseJSON — теряли фолбэк на "спасение" обрезанного ответа

    if (data && data.items && Array.isArray(data.items) && data.items.length > 0) {
      let addedCount = 0;
      for (const item of data.items) {
        let fixedPrice = Number(item.price) || 0;

        if (isSmallItem(item.name) && fixedPrice > 500000) {
          fixedPrice = Math.round(fixedPrice / 1000);
        }

        if (fixedPrice <= 0) continue;

        await processExpense(msg, {
          amount: fixedPrice,
          category: item.category || 'Продукты',
          description: item.name || 'Покупка по чеку',
          type: item.type || 'Общий'
        });
        addedCount++;
      }

      if (addedCount === 0) {
        await safeSendMessage(chatId, '🐗 На чеке нашлись позиции, но ни у одной не разобралась цена.');
      }
    } else {
      await safeSendMessage(chatId, '🐗 Кабан не смог разглядеть позиций на чеке.');
    }

  } catch (error) {
    const errorDetails = error.response?.data?.error?.message || error.message || String(error);
    console.error('❌ Ошибка в блоке photo:', error);
    await safeSendMessage(chatId, `🐗 Ошибка обработки фото: ${errorDetails}`);
  }
  });

  // ===================== Инлайн-кнопки =====================

  bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    console.error('answerCallbackQuery упал:', e.message);
  }

  if (query.data.startsWith('CURRENCY_')) {
    const currency = query.data.split('_')[1];
    userCurrencies[chatId] = currency;
    saveState();

    let rateInfo = '';
    if (currency === 'VND') rateInfo = `\nТекущий делитель курса: **${rates.VND || 330}**`;
    if (currency === 'THB') rateInfo = `\nТекущий делитель курса: **${rates.THB || 0.38}**`;

    await safeSendMessage(chatId, `🐗 Теперь вводи суммы в ${currency}.${rateInfo}`, { parse_mode: 'Markdown' });
  } else if (query.data.startsWith('DELETE_MSG_')) {
    const targetMsgId = Number(query.data.split('_')[2]);

    if (pendingDeletions.has(targetMsgId)) return;
    pendingDeletions.add(targetMsgId);

    try {
      await bot.editMessageText('⏳ *Удаляю трату из таблицы...*', {
        chat_id: chatId,
        message_id: targetMsgId,
        parse_mode: 'Markdown'
      });
    } catch (e) {
      console.error('Не удалось показать "удаляю...":', e.message);
    }

    await handleDeleteExpense(chatId, userId, targetMsgId);
  }
  });

  // ===================== Обработчик текста =====================

  bot.on('message', async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();

  if (userStates[chatId] === 'AWAITING_RATE') {
    delete userStates[chatId];
    saveState();

    const newRate = parseFloat(text.replace(',', '.'));
    if (isNaN(newRate) || newRate <= 0) {
      return safeSendMessage(chatId, '❌ Некорректное число.');
    }

    const currentCurr = userCurrencies[chatId] || 'VND';
    rates[currentCurr] = newRate;
    saveRates();

    return safeSendMessage(chatId, `✅ *Курс для ${currentCurr} обновлен:* \`${newRate}\``, { parse_mode: 'Markdown' });
  }

  if (text === '/start') return sendMainMenu(chatId);

  if (text === '💱 Валюта' || text === '/currency') {
    return safeSendMessage(chatId, 'Выбери валюту для ввода трат:', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🇻🇳 Донги (VND)', callback_data: 'CURRENCY_VND' },
            { text: '🇷🇺 Рубли (RUB)', callback_data: 'CURRENCY_RUB' },
            { text: '🇹🇭 Баты (THB)', callback_data: 'CURRENCY_THB' }
          ]
        ]
      }
    });
  }

  if (text === '⚙️ Изменить курс' || text === '/setrate') {
    const currentCurr = userCurrencies[chatId] || 'VND';
    if (currentCurr === 'RUB') {
      return safeSendMessage(chatId, '🐗 Переключи валюту на VND или THB.');
    }
    userStates[chatId] = 'AWAITING_RATE';
    saveState();
    return safeSendMessage(chatId, `⚙️ Введи новый делитель для **${currentCurr}**:`, { parse_mode: 'Markdown' });
  }

  if (text === '📊 Статистика') return handleAnalytics(msg);
  if (text === '🗑 Удалить последнюю' || text === '/delete') return handleDeleteExpense(chatId, userId, null);

  // Обработка текстовой траты
  if (!text.startsWith('/')) {
    try {
      const rawContent = await callGroq({
        model: GROQ_TEXT_MODEL, // было: 'llama-3.3-70b-versatile' — отключена Groq 16.08.2026, отсюда и баг
        timeout: 20000,
        maxTokens: 2048,
        // reasoning_effort: 'low' — GPT-OSS не поддерживает 'none', но
        // 'low' минимизирует скрытые рассуждения. Простой разбор фразы
        // вроде "пиво 400" не требует глубокого мышления, а на длинных
        // сообщениях (несколько трат подряд) риск та же болезнь, что и с
        // фото — рассуждения съедают весь лимит токенов.
        extra: { reasoning_format: 'hidden', reasoning_effort: 'low' },
        system: `Разбери сообщение и верни СТРОГО JSON.
{
  "intent": "add_expense" | "delete" | "analytics",
  "expenses": [
    {
      "amount": число,
      "category": "Категория",
      "description": "Описание",
      "type": "Общий" | "Личный"
    }
  ]
}

Категории: ${CATEGORIES.join(', ')}.
Тип: "${EXPENSE_TYPES.join('" или "')}".`,
        userContent: text
      });

      let parsed = cleanAndParseJSON(rawContent);

      if (parsed.intent === 'analytics') return handleAnalytics(msg);
      if (parsed.intent === 'delete') return handleDeleteExpense(chatId, userId, null);

      let expensesList = Array.isArray(parsed.expenses) ? parsed.expenses : [];

      if (expensesList.length === 0) {
        return safeSendMessage(chatId, '🐗 Не понял, что за трата. Напиши в формате: `Пиво 400`', { parse_mode: 'Markdown' });
      }

      for (const item of expensesList) {
        if (item.amount) {
          await processExpense(msg, {
            amount: Number(item.amount),
            category: item.category || 'Продукты',
            description: item.description || 'Трата',
            type: item.type || 'Общий'
          });
        }
      }

    } catch (error) {
      console.error('Ошибка разбора текста:', error.message);
      await safeSendMessage(chatId, '🐗 Напиши трату в формате: `Такси 300`', { parse_mode: 'Markdown' });
    }
  }
  });
}

// Защита от неожиданных сбоев
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err?.message || err));

async function verifyTelegramToken(token) {
  const { data } = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 15000 });
  if (!data.ok) {
    throw new Error(data.description || 'getMe failed');
  }
  return data.result;
}

async function clearTelegramWebhook(token) {
  const { data } = await axios.get(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    params: { drop_pending_updates: false },
    timeout: 15000
  });
  if (!data.ok) {
    console.warn('⚠️ deleteWebhook:', data.description || 'unknown warning');
  } else if (data.result) {
    console.log('🔗 Webhook сброшен, включаем polling.');
  }
}

async function startBot() {
  const config = readEnvConfig();
  botToken = config.botToken;
  groqApiKey = config.groqApiKey;
  googleScriptUrl = config.googleScriptUrl;

  if (!validateEnvConfig(config)) return;

  logTokenDiagnostics(config.botToken);

  try {
    const me = await verifyTelegramToken(config.botToken);
    await clearTelegramWebhook(config.botToken);

    activeBotToken = config.botToken;
    bot = new TelegramBot(config.botToken, { polling: false });
    registerBotHandlers();

    await bot.startPolling({ interval: 500, params: { timeout: 10 } });
    console.log(`✅ Бот "Кабан Финансист" запущен: @${me.username} (id ${me.id})`);
  } catch (err) {
    if (err.response?.status === 401) {
      console.error('❌ 401 Unauthorized — Telegram не принял TELEGRAM_BOT_TOKEN.');
      console.error('   На Render обнови именно Environment Variables (Key: TELEGRAM_BOT_TOKEN).');
      console.error('   Secret File (.env) не перезаписывает переменные из панели.');
    } else {
      console.error('❌ Не удалось запустить бота:', err.response?.data?.description || err.message);
    }
  }
}

startBot();




