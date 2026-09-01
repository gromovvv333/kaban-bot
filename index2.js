const http = require('http');

// Поднимаем веб-сервер для Render
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
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Очистка переменных окружения
function cleanEnvVar(val) {
  if (!val) return '';
  return String(val).trim().replace(/^["']|["']$/g, '');
}

const botToken = cleanEnvVar(process.env.TELEGRAM_BOT_TOKEN);
const scriptUrlEnv = cleanEnvVar(process.env.GOOGLE_SCRIPT_URL);
const groqKeyEnv = cleanEnvVar(process.env.GROQ_API_KEY);

// Файл курсов
const RATES_FILE = path.join(__dirname, 'rates.json');
let rates = { VND: 330, THB: 0.38 };

function loadRates() {
  try {
    if (fs.existsSync(RATES_FILE)) {
      const data = fs.readFileSync(RATES_FILE, 'utf8');
      rates = JSON.parse(data);
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

// Инициализация бота без перегруженных кастомных агентов
const bot = new TelegramBot(botToken, {
  polling: {
    interval: 500,
    autoStart: true,
    params: { timeout: 10 }
  }
});

bot.on('polling_error', (error) => {
  console.log(`[Polling Error]: ${error.message}`);
});

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
        throw err;
      }
    }
  }
}

// Глубокий парсер и чистильщик JSON для нейросетей
function cleanAndParseJSON(rawText) {
  let text = (rawText || '').trim();
  
  if (text.includes('</think>')) {
    text = text.split('</think>')[1];
  }
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
  
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    text = text.substring(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    console.log('⚠️ Применяется доп. очистка кавычек и переносов...');
    let sanitized = text
      .replace(/\r?\n/g, ' ')
      .replace(/([{,]\s*"[a-zA-Z0-9_]+"s*:\s*)"([^"]*)"/g, (match, p1, p2) => {
        return p1 + '"' + p2.replace(/"/g, "'") + '"';
      });

    return JSON.parse(sanitized);
  }
}

const userCurrencies = {};
const userStates = {};
const pendingDeletions = new Set();

const USERS = {
  336595543: 'Главный кабан',
  333816615: 'Кабанка'
};

// Функция удаления
async function handleDeleteExpense(chatId, userId, messageIdToDelete = null) {
  const scriptUrl = cleanEnvVar(process.env.GOOGLE_SCRIPT_URL);
  if (!scriptUrl || !scriptUrl.startsWith('http')) {
    if (messageIdToDelete) pendingDeletions.delete(messageIdToDelete);
    return safeSendMessage(chatId, '🐗 Некорректный GOOGLE_SCRIPT_URL!');
  }

  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || '';

  try {
    await axios.post(scriptUrl, {
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
      } catch (e) {}
    } else {
      await safeSendMessage(chatId, '🗑 *Последняя трата удалена из таблицы!*', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    if (messageIdToDelete) {
      try {
        await bot.editMessageText('❌ *Эта трата отменена.*', {
          chat_id: chatId,
          message_id: messageIdToDelete,
          parse_mode: 'Markdown'
        });
      } catch (e) {}
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

// Запись траты
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
      await axios.post(scriptUrl, {
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

// Аналитика
async function handleAnalytics(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || 'Главный кабан';

  await safeSendMessage(chatId, '🐗 *Кабан роет в таблицах и считает желуди... Секундочку!*', { parse_mode: 'Markdown' });

  const scriptUrl = cleanEnvVar(process.env.GOOGLE_SCRIPT_URL);
  if (!scriptUrl || !scriptUrl.startsWith('http')) {
    return safeSendMessage(chatId, '🐗 Некорректный GOOGLE_SCRIPT_URL!');
  }

  try {
    const tableDataResponse = await axios.get(scriptUrl, { timeout: 15000 });
    const historyData = tableDataResponse.data;
    const groqKey = cleanEnvVar(process.env.GROQ_API_KEY);

    const analyticsAiResponse = await axios.post(
      '[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4096,
        messages: [
          {
            role: 'system',
            content: `Ты — харизматичный финансовый аналитик "Кабан Финансист". Пользователь: "${kabanName}".
История трат в JSON: ${JSON.stringify(historyData)}.

ПРАВИЛА:
1. НИКОГДА НЕ ИСПОЛЬЗУЙ РЕШЁТКИ (#, ##) для заголовков!
2. Для заголовков используй ЭМОДЗИ + ЖИРНЫЙ ТЕКСТ.
3. Пиши с кабанским юмором.`
          },
          { role: 'user', content: msg.text || 'Покажи аналитику трат' }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const aiAnalyticsAnswer = analyticsAiResponse.data.choices[0].message.content;
    return await safeSendMessage(chatId, aiAnalyticsAnswer, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Ошибка аналитики:', error.message);
    safeSendMessage(chatId, '🐗 Упс! Кабан не смог прочесть аналитику.');
  }
}

// Обработка Фото (Чеков)
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;

  try {
    await bot.sendChatAction(chatId, 'typing');
  } catch (e) {}

  try {
    if (!msg.photo || !Array.isArray(msg.photo) || msg.photo.length === 0) {
      return safeSendMessage(chatId, '🐗 Ошибка: Telegram не передал массив фото.');
    }

    // Берем самое крупное фото
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    // ПРОВЕРКА 1: Проверяем, что file_id вообще существует и это строка
    if (!fileId || typeof fileId !== 'string') {
      console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: file_id не является строкой!', photo);
      return safeSendMessage(chatId, '🐗 Ошибка: Некорректный ID файла от Telegram.');
    }

    const token = cleanEnvVar(process.env.TELEGRAM_BOT_TOKEN);
    if (!token) {
      return safeSendMessage(chatId, '🐗 Ошибка: Не задан TELEGRAM_BOT_TOKEN в переменных!');
    }

    // 1. Получаем путь к файлу напрямую через Telegram API
    const getFileApiUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
    
    // Используем нативный fetch Node.js вместо сторонних библиотек
    const fileRes = await fetch(getFileApiUrl);
    const fileData = await fileRes.json();

    if (!fileData.ok || !fileData.result || !fileData.result.file_path) {
      console.error('❌ Ошибка ответа Telegram getFile:', fileData);
      return safeSendMessage(chatId, '🐗 Telegram не отдал путь к файлу чека.');
    }

    const cleanFilePath = String(fileData.result.file_path).trim();
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${cleanFilePath}`;
    
    console.log('--> Ссылка на скачивание успешно собрана:', downloadUrl);

    // 2. Скачиваем файл через axios как бинарник
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
    const groqKey = cleanEnvVar(process.env.GROQ_API_KEY);

    if (!groqKey) {
      return safeSendMessage(chatId, '🐗 Ошибка: Не задан GROQ_API_KEY!');
    }

    // 4. Запрос к Groq Vision
    const visionResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'qwen/qwen3.6-27b',
        reasoning_format: 'hidden',
        temperature: 0.1,
        max_tokens: 4096,
        messages: [
          {
            role: 'system',
            content: `Ты модуль распознавания чеков. Выдели ВСЕ товары и цены.
Верни СТРОГО валидный JSON-объект без пояснений.

ВНИМАНИЕ: В названиях товаров НЕ используй двойные кавычки.

ФОРМАТ JSON:
{
  "items": [
    {
      "name": "Название товара",
      "price": 50000,
      "category": "Продукты",
      "type": "Общий"
    }
  ]
}

Категории: Продукты, Бухло, Вкусняшки кабаньи, Транспорт, Жилье и Коммуналка, Развлечения и Отдых, Здоровье и Аптека, Покупки и Шмотки, Кафе и Рестораны, Подарки и Донаты.
Тип: "Личный" или "Общий".`
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: captionText },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${base64Image}` }
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
        timeout: 60000
      }
    );
    
    const rawContent = visionResponse.data?.choices?.[0]?.message?.content;
    let data = cleanAndParseJSON(rawContent);
    
    if (data && data.items && Array.isArray(data.items) && data.items.length > 0) {
      for (const item of data.items) {
        let fixedPrice = Number(item.price) || 0;
        const lowerName = (item.name || '').toLowerCase();

        const isSmallItem = lowerName.includes('вод') || lowerName.includes('water') || lowerName.includes('кофе') || 
                            lowerName.includes('чай') || lowerName.includes('чипсы') || lowerName.includes('пиво');

        if (isSmallItem && fixedPrice > 500000) {
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
      safeSendMessage(chatId, '🐗 Кабан не смог разглядеть позиций на чеке.');
    }

  } catch (error) {
    const errorDetails = error.response?.data?.error?.message || error.message || String(error);
    console.error('❌ Ошибка в блоке photo:', error);
    safeSendMessage(chatId, `🐗 Ошибка обработки фото: ${errorDetails}`);
  }
});

// Инлайн-кнопки
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  try { await bot.answerCallbackQuery(query.id); } catch (e) {}

  if (query.data.startsWith('CURRENCY_')) {
    const currency = query.data.split('_')[1];
    userCurrencies[chatId] = currency;
    
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
    } catch (e) {}

    await handleDeleteExpense(chatId, userId, targetMsgId);
  }
});

// Обработчик текста
bot.on('message', async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();

  if (userStates[chatId] === 'AWAITING_RATE') {
    delete userStates[chatId];
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
    return safeSendMessage(chatId, `⚙️ Введи новый делитель для **${currentCurr}**:`, { parse_mode: 'Markdown' });
  }

  if (text === '📊 Статистика') return handleAnalytics(msg);
  if (text === '🗑 Удалить последнюю' || text === '/delete') return handleDeleteExpense(chatId, userId, null);

  // Обработка текстовой траты
  if (!text.startsWith('/')) {
    try {
      const groqKey = cleanEnvVar(process.env.GROQ_API_KEY);
      const singleAiResponse = await axios.post(
        '[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)',
        {
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: `Разбери сообщение и верни СТРОГО JSON.
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
}`
            },
            { role: 'user', content: text }
          ]
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

      if (parsed.intent === 'analytics') return handleAnalytics(msg);
      if (parsed.intent === 'delete') return handleDeleteExpense(chatId, userId, null);

      let expensesList = Array.isArray(parsed.expenses) ? parsed.expenses : [];

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
      safeSendMessage(chatId, '🐗 Напиши трату в формате: `Такси 300`');
    }
  }
});

// Защита от неожиданных сбоев
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err?.message || err));

console.log('Бот "Кабан Финансист" запущен!');




