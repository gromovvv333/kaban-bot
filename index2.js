const http = require('http');

// Поднимаем фейковый веб-сервер для Render
const port = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kaban Financier is alive!');
}).listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Хелпер для жесткой очистки URL и токенов из env
function cleanEnvVar(val) {
  if (!val) return '';
  return String(val).trim().replace(/^["']|["']$/g, '');
}

// Файл для автономного хранения курсов
const RATES_FILE = path.join(__dirname, 'rates.json');

// Загрузка или инициализация курсов (по умолчанию делители: VND = 330, THB = 0.38)
let rates = { VND: 330, THB: 0.38 };

function loadRates() {
  try {
    if (fs.existsSync(RATES_FILE)) {
      const data = fs.readFileSync(RATES_FILE, 'utf8');
      rates = JSON.parse(data);
      console.log('Курсы успешно загружены из rates.json:', rates);
    } else {
      saveRates();
    }
  } catch (err) {
    console.error('Ошибка чтения rates.json, используются значения по умолчанию:', err.message);
  }
}

function saveRates() {
  try {
    fs.writeFileSync(RATES_FILE, JSON.stringify(rates, null, 2), 'utf8');
    console.log('Курсы успешно сохранены в rates.json:', rates);
  } catch (err) {
    console.error('Ошибка сохранения rates.json:', err.message);
  }
}

// Загружаем курсы при старте
loadRates();

// ==================== НАСТРОЙКА СЕТИ И БОТА ====================

const httpsAgent = new https.Agent({
  keepAlive: false,
  timeout: 30000,
  freeSocketTimeout: 5000
});

const axiosClient = axios.create({
  httpsAgent,
  maxRedirects: 5,
  headers: {
    'Connection': 'close'
  }
});

const botToken = cleanEnvVar(process.env.TELEGRAM_BOT_TOKEN);
const bot = new TelegramBot(botToken, {
  polling: {
    interval: 500,
    autoStart: true,
    params: { 
      timeout: 10
    }
  },
  request: {
    agent: httpsAgent,
    timeout: 30000
  }
});

bot.on('polling_error', (error) => {
  if (error.code === 'EFATAL') {
    console.log('⚠️ [Сбой TLS/Сети]: Переподключение к Telegram...');
  } else {
    console.log(`[Polling Error]: ${error.message}`);
  }
});

// Безопасная отправка сообщений с авто-повтором при сетевых миганиях
async function safeSendMessage(chatId, text, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await bot.sendMessage(chatId, text, options);
    } catch (err) {
      if ((err.code === 'EFATAL' || err.code === 'ETIMEDOUT') && i < retries - 1) {
        console.log(`⚠️ Сетевой сбой при отправке (попытка ${i + 1}/${retries}), повтор через 1 сек...`);
        await new Promise((res) => setTimeout(res, 1000));
      } else if (err.message && err.message.includes('PARSE_MODE') && options.parse_mode) {
        delete options.parse_mode;
        return await bot.sendMessage(chatId, text, options);
      } else {
        throw err;
      }
    }
  }
}

// Вспомогательная функция очистки и бронебойного парсинга JSON
function cleanAndParseJSON(rawText) {
  let text = (rawText || '').trim();
  
  // 1. Вырезаем блоки мыслей <think>...</think>
  if (text.includes('</think>')) {
    text = text.split('</think>')[1];
  }
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  
  // 2. Очищаем маркдаун-обертки ```json ... ```
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
  
  // 3. Вырезаем всё, что находится ДО первой { и ПОСЛЕ последней }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    text = text.substring(firstBrace, lastBrace + 1);
  }

  // 4. Прямая попытка парсинга
  try {
    return JSON.parse(text);
  } catch (err) {
    console.log('⚠️ Прямой JSON.parse не удался, применяем глубинную очистку спецсимволов...');
    
    // Экранируем переносы строк и исправляем кавычки внутри текстовых полей
    let sanitized = text
      .replace(/\r?\n/g, ' ')
      .replace(/([{,]\s*"[a-zA-Z0-9_]+"s*:\s*)"([^"]*)"/g, (match, p1, p2) => {
        return p1 + '"' + p2.replace(/"/g, "'") + '"';
      });

    return JSON.parse(sanitized);
  }
}

// Храним валюту по пользователям (по chatId)
const userCurrencies = {};

// Храним состояние ожидания ввода нового курса
const userStates = {};

// Защита от повторных кликов по кнопкам удаления
const pendingDeletions = new Set();

// СЛОВАРЬ ПОЛЬЗОВАТЕЛЕЙ
const USERS = {
  336595543: 'Главный кабан',  // Твой Telegram ID
  333816615: 'Кабанка'         // Telegram ID Алисы
};

// Функция точечного удаления конкретной траты (или последней из меню)
async function handleDeleteExpense(chatId, userId, messageIdToDelete = null) {
  const scriptUrl = cleanEnvVar(process.env.GOOGLE_SCRIPT_URL);
  if (!scriptUrl || !scriptUrl.startsWith('http')) {
    if (messageIdToDelete) pendingDeletions.delete(messageIdToDelete);
    return safeSendMessage(chatId, '🐗 Хрю! Не могу удалить запись, некорректный GOOGLE_SCRIPT_URL!');
  }

  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || '';

  try {
    await axiosClient.post(scriptUrl, {
      action: messageIdToDelete ? 'delete_by_id' : 'delete_last',
      telegramId: userId,
      user: kabanName,
      messageId: messageIdToDelete
    }, {
      timeout: 12000
    });

    if (messageIdToDelete) {
      try {
        await bot.editMessageText('❌ *Эта конкретная трата была отменена и удалена из таблицы!*', {
          chat_id: chatId,
          message_id: messageIdToDelete,
          parse_mode: 'Markdown'
        });
      } catch (e) {}
    } else {
      await safeSendMessage(chatId, '🗑 *Твоя последняя трата успешно удалена из таблицы!*', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.log('Запрос на удаление обработан или прошёл с таймаутом:', err.message);
    
    if (messageIdToDelete) {
      try {
        await bot.editMessageText('❌ *Эта конкретная трата отменена.*', {
          chat_id: chatId,
          message_id: messageIdToDelete,
          parse_mode: 'Markdown'
        });
      } catch (e) {}
    } else {
      await safeSendMessage(chatId, '🗑 *Твоя последняя трата удалена!*', { parse_mode: 'Markdown' });
    }
  } finally {
    if (messageIdToDelete) {
      pendingDeletions.delete(messageIdToDelete);
    }
  }
}

// Функция отправки стандартного меню (4 кнопки)
async function sendMainMenu(chatId) {
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

// Функция обработки и сохранения одной траты
async function processExpense(msg, data) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || 'Главный кабан';
  
  const currentCurr = userCurrencies[chatId] || 'VND';
  
  const rawAmount = Number(data.amount) || 0;
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
  } catch (e) {}

  const scriptUrl = cleanEnvVar(process.env.GOOGLE_SCRIPT_URL);
  if (scriptUrl && scriptUrl.startsWith('http')) {
    try {
      const payload = {
        action: 'add',
        telegramId: userId,
        user: kabanName,
        amountRub: amountRub,
        category: data.category,
        name: data.description || '',
        type: data.type || 'Общий',
        messageId: sentMessageId
      };

      const response = await axiosClient.post(scriptUrl, payload);
      console.log('--- УСПЕШНО ОТПРАВЛЕНО В GOOGLE ТАБЛИЦЫ ---', response.data);
    } catch (err) {
      console.error('Ошибка записи в Google Таблицу:', err.message);
    }
  } else {
    console.warn('⚠️ GOOGLE_SCRIPT_URL не задан или имеет некорректный формат:', scriptUrl);
  }
}

// Функция ИИ-аналитики
async function handleAnalytics(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || 'Главный кабан';

  await safeSendMessage(chatId, '🐗 *Кабан роет в таблицах и считает желуди... Секундочку!*', { parse_mode: 'Markdown' });

  const scriptUrl = cleanEnvVar(process.env.GOOGLE_SCRIPT_URL);
  if (!scriptUrl || !scriptUrl.startsWith('http')) {
    return safeSendMessage(chatId, '🐗 Хрю! Не могу прочитать таблицу, некорректный GOOGLE_SCRIPT_URL!');
  }

  try {
    const tableDataResponse = await axiosClient.get(scriptUrl);
    const historyData = tableDataResponse.data;

    const groqKey = cleanEnvVar(process.env.GROQ_API_KEY);
    const analyticsAiResponse = await axiosClient.post(
      '[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4096,
        messages: [
          {
            role: 'system',
            content: `Ты — харизматичный, уверенный и остроумный финансовый аналитик по имени "Кабан Финансист". 
Пользователь, который тебя спрашивает: "${kabanName}". Вторая половинка: "${kabanName === 'Главный кабан' ? 'Кабанка (Алиса)' : 'Главный кабан'}".

Вот вся история трат в JSON формате: ${JSON.stringify(historyData)}.

СТРОГИЕ ПРАВИЛА ОФОРМЛЕНИЯ ТЕКСТА (ДЛЯ TELEGRAM MARKDOWN):
1. НИКОГДА НЕ ИСПОЛЬЗУЙ РЕШЁТКИ (#, ##, ###) для заголовков!
2. Для визуального выделения заголовков используй ТОЛЬКО ЭМОДЗИ + ЖИРНЫЙ ТЕКСТ (например: 📊 *Кабанский отчёт:*).
3. Используй аккуратные списки через дефис (-) или эмодзи (🐗, 🍺, 💸).
4. Пиши строго на правильном русском языке.

СТРУКТУРА ОТВЕТА:
🐗 [Динамичное приветствие с уважением/поклоном и новым обращением]

📊 *Статистика и цифры*
[Выжимка по суммам, категориям и личным/общим тратам]

🧐 *Кабанский анализ*
[Кто сколько потратил, сравнение, динамика]

🪵 *Желудёвая мудрость и совет*
[Кабанский юмор, метафоры про хрю-экономику, дубы и резкий совет]`
          },
          { role: 'user', content: msg.text || 'Покажи аналитику трат' }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const aiAnalyticsAnswer = analyticsAiResponse.data.choices[0].message.content;
    return await safeSendMessage(chatId, aiAnalyticsAnswer, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Ошибка генерации аналитики:', error.message);
    safeSendMessage(chatId, '🐗 Упс! Кабан не смог прочесть аналитику.');
  }
}

// Обработчик фото сообщений (чеков)
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;

  try {
    await bot.sendChatAction(chatId, 'typing');
  } catch (e) {}

  try {
    const photo = msg.photo[msg.photo.length - 1];
    const token = cleanEnvVar(process.env.TELEGRAM_BOT_TOKEN);

    if (!token) {
      return safeSendMessage(chatId, '🐗 Ошибка: Не задан TELEGRAM_BOT_TOKEN!');
    }

    // 1. Получаем путь к файлу с экранированием URL
    const getFileUrl = `[https://api.telegram.org/bot$](https://api.telegram.org/bot$){token}/getFile?file_id=${encodeURIComponent(photo.file_id)}`;
    console.log('--> Запрос пути к файлу:', getFileUrl);

    const fileInfoRes = await axios.get(getFileUrl);
    const filePath = fileInfoRes.data?.result?.file_path;

    if (!filePath) {
      throw new Error('Telegram API не вернул file_path');
    }

    // 2. Скачиваем оригинальный файл
    const cleanFilePath = String(filePath).trim();
    const fileDownloadUrl = `[https://api.telegram.org/file/bot$](https://api.telegram.org/file/bot$){token}/${cleanFilePath}`;
    console.log('--> Скачивание файла:', fileDownloadUrl);

    const imageResponse = await axios.get(fileDownloadUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000 
    });

    // 3. Сжимаем через sharp
    const compressedBuffer = await sharp(imageResponse.data)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const base64Image = compressedBuffer.toString('base64');
    const captionText = msg.caption ? `Подпись к чеку: "${msg.caption}"` : 'Без подписи.';

    const groqKey = cleanEnvVar(process.env.GROQ_API_KEY);

    if (!groqKey) {
      return safeSendMessage(chatId, '🐗 Ошибка: Не задан GROQ_API_KEY!');
    }

    // 4. Запрос к Groq API с увеличенным запасом токенов
    const visionResponse = await axiosClient.post(
      '[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)',
      {
        model: 'qwen/qwen3.6-27b',
        reasoning_format: 'hidden',
        response_format: { type: 'json_object' },
        temperature: 0.0,
        max_tokens: 4096,
        messages: [
          {
            role: 'system',
            content: `Ты модуль распознавания чеков. Выдели ВСЕ товары и их цены из чека.
Ты ДОЛЖЕН вернуть СТРОГО валидный JSON-объект. Никакого текста до или после JSON.

ВНИМАНИЕ К КАВЫЧКАМ: В названии товаров НЕ ИСПОЛЬЗУЙ двойные кавычки. Если в чеке написано Хлеб "Даниловский", пиши: Хлеб Даниловский.

ФОРМАТ JSON:
{
  "items": [
    {
      "name": "Краткое название без кавычек",
      "price": 50000,
      "category": "Продукты",
      "type": "Общий"
    }
  ]
}

Категории: Продукты, Бухло, Вкусняшки кабаньи, Транспорт, Жилье и Коммуналка, Развлечения и Отдых, Здоровье и Аптека, Покупки и Шмотки, Кафе и Рестораны, Подарки и Донаты.
Тип: "Личный" или "Общий".

ПРАВИЛА ДЛЯ ВЬЕТНАМСКИХ ЧЕКОВ (VND):
Точки и запятые — это разделители тысяч (например, 70.000 = 70000, 1.200.000 = 1200000).`
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: captionText },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ]
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 45000
      }
    );
    
    const rawContent = visionResponse.data?.choices?.[0]?.message?.content;
    
    console.log('--- СЫРОЙ ОТВЕТ ОТ GROQ VISION ---');
    console.log(rawContent);
    console.log('----------------------------------');

    let data;

    try {
      data = cleanAndParseJSON(rawContent);
    } catch (parseErr) {
      console.error('❌ Не удалось распарсить JSON. Ошибка:', parseErr.message);
      return safeSendMessage(
        chatId, 
        '🐗 Не удалось разобрать структуру чека. Попробуй сфотографировать ровнее или ближе!'
      );
    }
    
    if (data && data.items && Array.isArray(data.items) && data.items.length > 0) {
      for (const item of data.items) {
        let fixedPrice = Number(item.price) || 0;
        const lowerName = (item.name || '').toLowerCase();

        const isSmallItem = lowerName.includes('вод') || lowerName.includes('water') || lowerName.includes('minh') || 
                            lowerName.includes('кофе') || lowerName.includes('чай') || lowerName.includes('снек') || 
                            lowerName.includes('чипсы') || lowerName.includes('пиво') || lowerName.includes('хлеб');

        if (isSmallItem && fixedPrice > 500000) {
          fixedPrice = Math.round(fixedPrice / 1000);
        } else if (fixedPrice > 10000000) {
          fixedPrice = Math.round(fixedPrice / 1000);
        }

        await processExpense(msg, {
          amount: fixedPrice,
          category: item.category || 'Продукты',
          description: item.name || 'Покупка по чеку',
          type: item.type || 'Общий'
        });
      }
    } else {
      safeSendMessage(chatId, '🐗 Кабан присмотрелся, но не разглядел позиций на чеке.');
    }

  } catch (error) {
    const errorDetails = error.response?.data?.error?.message || error.message || String(error);
    console.error('Ошибка обработки фото:', errorDetails);

    if (errorDetails.includes('rate_limit') || errorDetails.includes('TPM') || error.response?.data?.error?.code === 'rate_limit_exceeded') {
      return safeSendMessage(
        chatId, 
        '🐗 *Кабан упёрся в лимит нейросети!* Подожди 10-15 секунд и отправь чек снова.', 
        { parse_mode: 'Markdown' }
      );
    }

    safeSendMessage(chatId, `🐗 Ошибка обработки фото: ${errorDetails}`);
  }
});

// Обработчик инлайн-кнопок
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {}

  if (query.data.startsWith('CURRENCY_')) {
    const currency = query.data.split('_')[1];
    userCurrencies[chatId] = currency;
    
    let rateInfo = '';
    if (currency === 'VND') {
      rateInfo = `\nТекущий делитель курса: **${rates.VND || 330}**`;
    } else if (currency === 'THB') {
      rateInfo = `\nТекущий делитель курса: **${rates.THB || 0.38}**`;
    }

    await safeSendMessage(
      chatId,
      `🐗 Теперь вводи суммы в ${currency}.${rateInfo}`,
      { parse_mode: 'Markdown' }
    );
  } else if (query.data.startsWith('DELETE_MSG_')) {
    const targetMsgId = Number(query.data.split('_')[2]);

    if (pendingDeletions.has(targetMsgId)) {
      console.log(`⚠️ Попытка повторного клика по сообщению ${targetMsgId} заблокирована.`);
      return;
    }

    pendingDeletions.add(targetMsgId);

    try {
      await bot.editMessageText('⏳ *Удаляю трату из таблицы...*', {
        chat_id: chatId,
        message_id: targetMsgId,
        parse_mode: 'Markdown'
      });
    } catch (e) {}

    await handleDeleteExpense(chatId, userId, targetMsgId);
  } else if (query.data === 'DELETE_LAST') {
    await handleDeleteExpense(chatId, userId, null);
  }
});

// ЕДИНЫЙ ОБРАБОТЧИК ТЕКСТА
bot.on('message', async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();

  // 0. ОБРАБОТКА ВВОДА НОВОГО КУРСА
  if (userStates[chatId] === 'AWAITING_RATE') {
    delete userStates[chatId];

    const newRate = parseFloat(text.replace(',', '.'));
    if (isNaN(newRate) || newRate <= 0) {
      return safeSendMessage(chatId, '❌ *Некорректное число.* Изменение курса отменено.', { parse_mode: 'Markdown' });
    }

    const currentCurr = userCurrencies[chatId] || 'VND';
    rates[currentCurr] = newRate;
    saveRates();

    let exampleText = '';
    if (currentCurr === 'VND') {
      exampleText = `Пример: 100 000 VND теперь = **${(100000 / newRate).toFixed(2)} ₽**`;
    } else if (currentCurr === 'THB') {
      exampleText = `Пример: 100 THB теперь = **${(100 / newRate).toFixed(2)} ₽**`;
    }

    return safeSendMessage(
      chatId,
      `✅ *Курс для ${currentCurr} успешно обновлен!*\nНовое значение делителя: \`${newRate}\`\n${exampleText}`,
      { parse_mode: 'Markdown' }
    );
  }

  // 1. Команда /start
  if (text === '/start') {
    return sendMainMenu(chatId);
  }

  // 2. Кнопка «Валюта»
  if (text === '💱 Валюта' || text === '/currency') {
    const options = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🇻🇳 Донги (VND)', callback_data: 'CURRENCY_VND' },
            { text: '🇷🇺 Рубли (RUB)', callback_data: 'CURRENCY_RUB' },
            { text: '🇹🇭 Баты (THB)', callback_data: 'CURRENCY_THB' }
          ]
        ]
      }
    };
    return safeSendMessage(chatId, 'Выбери валюту для ввода трат:', options);
  }

  // 3. Кнопка «Изменить курс»
  if (text === '⚙️ Изменить курс' || text === '/setrate') {
    const currentCurr = userCurrencies[chatId] || 'VND';

    if (currentCurr === 'RUB') {
      return safeSendMessage(
        chatId,
        '🐗 *Для рубля курс менять не нужно (1 RUB = 1 RUB).* \n\nСначала переключи валюту на **VND** или **THB** через кнопку «💱 Валюта».',
        { parse_mode: 'Markdown' }
      );
    }

    userStates[chatId] = 'AWAITING_RATE';
    const currentDivider = rates[currentCurr] || (currentCurr === 'VND' ? 330 : 0.38);

    return safeSendMessage(
      chatId,
      `⚙️ *Изменение курса для ${currentCurr}*\n\n` +
      `Текущее значение делителя: \`${currentDivider}\`\n\n` +
      `Введи новое число текстом (например, \`${currentCurr === 'VND' ? '320' : '0.36'}\`):`,
      { parse_mode: 'Markdown' }
    );
  }

  // 4. Кнопка «Статистика»
  if (text === '📊 Статистика') {
    return handleAnalytics(msg);
  }

  // 5. Кнопка и команда «Удалить последнюю»
  if (text === '🗑 Удалить последнюю' || text === '/delete' || text === '/undo') {
    return handleDeleteExpense(chatId, userId, null);
  }

  // 6. Обычный ввод трат
  if (!text.startsWith('/')) {
    try {
      console.log(`[ТЕКСТ ВХОД]: "${text}"`);
      const groqKey = cleanEnvVar(process.env.GROQ_API_KEY);

      const singleAiResponse = await axiosClient.post(
        '[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)',
        {
          model: 'llama-3.3-70b-versatile',
          reasoning_format: 'hidden',
          messages: [
            {
              role: 'system',
              content: `Ты — умный модуль распознавания финансовых трат.
Разбери сообщение пользователя и верни СТРОГО JSON-объект без пояснений.

ФОРМАТ JSON:
{
  "intent": "add_expense" | "delete" | "analytics",
  "expenses": [
    {
      "amount": число,
      "category": "Категория",
      "description": "Описание траты на русском",
      "type": "Общий" | "Личный"
    }
  ]
}

ПРАВИЛА:
1. intent: "delete" (если просит отменить/удалить), "analytics" (если просит отчёт/статистику), иначе "add_expense".
2. В ВЕТКЕ add_expense: Сообщение может содержать КАК ОДНУ ТРАТУ, ТАК И СПИСОК ТРАТ. Выдели ВСЕ отдельные траты в массив "expenses".
3. amount: Чистое число. Тысячные разделения (100 000) объединяй в 100000.
4. category: Из списка: Продукты, Бухло, Вкусняшки кабаньи, Транспорт, Жилье и Коммуналка, Развлечения и Отдых, Здоровье и Аптека, Покупки и Шмотки, Кафе и Рестораны, Подарки и Донаты.
5. type: "Личный" (если есть "себе", "мне", "личный", или шмотки/аптека) иначе "Общий".`
            },
            { role: 'user', content: text }
          ],
          response_format: { type: 'json_object' }
        },
        {
          headers: {
            'Authorization': `Bearer ${groqKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      let parsed = cleanAndParseJSON(singleAiResponse.data.choices[0].message.content);

      if (parsed.intent === 'analytics') {
        return handleAnalytics(msg);
      }
      if (parsed.intent === 'delete') {
        return handleDeleteExpense(chatId, userId, null);
      }

      let expensesList = Array.isArray(parsed.expenses) ? parsed.expenses : [];

      if (expensesList.length === 0) {
        if (parsed.amount || parsed.price) {
          expensesList.push(parsed);
        } else {
          const lines = text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
          for (const line of lines) {
            const cleanedText = line.replace(/(\d+)\s+(\d{3})/g, '$1$2').replace(',', '.');
            const match = cleanedText.match(/\d+(\.\d+)?/);
            if (match) {
              const fallbackAmount = parseFloat(match[0]);
              const fallbackDesc = line.replace(/\d+/g, '').trim() || 'Трата';
              expensesList.push({
                amount: fallbackAmount,
                category: 'Продукты',
                description: fallbackDesc,
                type: 'Общий'
              });
            }
          }
        }
      }

      if (expensesList.length === 0) {
        return safeSendMessage(
          chatId, 
          '🐗 Кабан не нашёл сумму в сообщении. Напиши цифрами, например: `Такси 300` или список:\n`Такси 300`\n`Пиво 500`', 
          { parse_mode: 'Markdown' }
        );
      }

      for (const item of expensesList) {
        let finalAmount = Number(item.amount || item.price) || 0;
        
        if (finalAmount > 0) {
          await processExpense(msg, {
            amount: finalAmount,
            category: item.category || 'Продукты',
            description: item.description || 'Трата',
            type: item.type || 'Общий'
          });
        }
      }

    } catch (error) {
      console.error('--- ОШИБКА ОБРАБОТКИ ТЕКСТА ---', error.response?.data || error.message);
      
      const lines = text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
      let processedAny = false;

      for (const line of lines) {
        const cleanedText = line.replace(/(\d+)\s+(\d{3})/g, '$1$2').replace(',', '.');
        const match = cleanedText.match(/\d+(\.\d+)?/);
        if (match) {
          const fallbackAmount = parseFloat(match[0]);
          await processExpense(msg, {
            amount: fallbackAmount,
            category: 'Продукты',
            description: line.replace(/\d+/g, '').trim() || 'Трата',
            type: 'Общий'
          });
          processedAny = true;
        }
      }

      if (!processedAny) {
        safeSendMessage(chatId, '🐗 Упс! Не смог найти сумму. Напиши, например: `Такси 300`.');
      }
    }
  }
});

// ГЛОБАЛЬНАЯ ЗАЩИТА ОТ ПАДЕНИЙ ПРОЦЕССА NODE.JS
process.on('uncaughtException', (error) => {
  console.error('⚠️ [КАБАН ПЕРЕХВАТИЛ ИСКЛЮЧЕНИЕ]:', error.message);
});

process.on('unhandledRejection', (reason) => {
  const errorMessage = reason?.message || String(reason);
  if (reason?.code === 'EFATAL' || errorMessage.includes('EFATAL')) {
    console.log('⚠️ [Сбой TLS/Сети]: Запрос был отменен сетевым фильтром.');
  } else {
    console.error('⚠️ [НЕОБРАБОТАННЫЙ ПРОМИС]:', errorMessage);
  }
});

console.log('Бот "Кабан Финансист" успешно запущен и готов!');



