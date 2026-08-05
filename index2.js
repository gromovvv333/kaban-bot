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
  keepAlive: false,        // Не держим зависшие сокеты
  timeout: 10000,          // Таймаут сокета 10 секунд
  freeSocketTimeout: 5000
});

const axiosClient = axios.create({
  httpsAgent,
  maxRedirects: 5,
  headers: {
    'Connection': 'close'
  }
});

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: {
    interval: 500,
    autoStart: true,
    params: { 
      timeout: 10          // Сбрасываем длинное висение Telegram
    }
  },
  request: {
    agent: httpsAgent,
    timeout: 15000
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

// Функция точечного удаления последней траты конкретного пользователя
async function handleDeleteLast(chatId, userId, messageIdToEdit = null) {
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL ? process.env.GOOGLE_SCRIPT_URL.trim() : null;
  if (!scriptUrl) {
    if (messageIdToEdit) pendingDeletions.delete(messageIdToEdit);
    return safeSendMessage(chatId, '🐗 Хрю! Не могу удалить запись, не задан GOOGLE_SCRIPT_URL!');
  }

  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || '';

  try {
    // Отправляем ID и Имя, чтобы Google удалил ИМЕННО ТРАТУ ЭТОГО КАБАНА
    await axiosClient.post(scriptUrl, {
      action: 'delete_last',
      telegramId: userId,
      user: kabanName
    }, {
      timeout: 12000
    });

    if (messageIdToEdit) {
      try {
        await bot.editMessageText('❌ *Эта трата была отменена и удалена из таблицы!*', {
          chat_id: chatId,
          message_id: messageIdToEdit,
          parse_mode: 'Markdown'
        });
      } catch (e) {}
    } else {
      await safeSendMessage(chatId, '🗑 *Твоя последняя трата успешно удалена из таблицы!*', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.log('Запрос на удаление обработан или прошёл с таймаутом.');
    
    if (messageIdToEdit) {
      try {
        await bot.editMessageText('❌ *Эта трата была отменена.*', {
          chat_id: chatId,
          message_id: messageIdToEdit,
          parse_mode: 'Markdown'
        });
      } catch (e) {}
    } else {
      await safeSendMessage(chatId, '🗑 *Твоя последняя трата удалена!*', { parse_mode: 'Markdown' });
    }
  } finally {
    // Снимаем блокировку после завершения
    if (messageIdToEdit) {
      pendingDeletions.delete(messageIdToEdit);
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

// Функция обработки и сохранения траты
async function processExpense(msg, data) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || 'Главный кабан';
  
  const currentCurr = userCurrencies[chatId] || 'RUB';
  
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
      '🐗🫡 *Служу Главому Кабану! Трата зафиксирована!*',
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
    `💸 *Сумма:* ${amountRub.toFixed(2)} ₽${currentCurr !== 'RUB' ? ` (${rawAmount.toLocaleString()} ${currentCurr}${currencySymbols[currentCurr]})` : ''}\n` +
    `📂 *Категория:* ${data.category}\n` +
    `📝 *Описание:* ${data.description || 'без описания'}\n` +
    `🏷 *Тип:* ${data.type || 'Общий'}\n\n` +
    `📊 _Зарубил на носу и отправляю в дубраву (таблицу)!_`;

  const options = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🗑 Отменить эту трату', callback_data: 'DELETE_LAST' }]
      ]
    }
  };

  await safeSendMessage(chatId, textMessage, options);

  const scriptUrl = process.env.GOOGLE_SCRIPT_URL ? process.env.GOOGLE_SCRIPT_URL.trim() : null;
  if (scriptUrl && scriptUrl.startsWith('http')) {
    try {
      const payload = {
        action: 'add',
        telegramId: userId,
        user: kabanName,
        amountRub: amountRub,
        category: data.category,
        name: data.description || '',
        type: data.type || 'Общий'
      };

      const response = await axiosClient.post(scriptUrl, payload);
      console.log('--- УСПЕШНО ОТПРАВЛЕНО В GOOGLE ТАБЛИЦЫ ---', response.data);
    } catch (err) {
      console.error('Ошибка записи в Google Таблицу:', err.message);
    }
  }
}

// Функция ИИ-аналитики
async function handleAnalytics(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const numericUserId = Number(userId);
  const kabanName = USERS[numericUserId] || USERS[userId] || 'Главный кабан';

  await safeSendMessage(chatId, '🐗 *Кабан роет в таблицах и считает желуди... Секундочку!*', { parse_mode: 'Markdown' });

  const scriptUrl = process.env.GOOGLE_SCRIPT_URL ? process.env.GOOGLE_SCRIPT_URL.trim() : null;
  if (!scriptUrl) {
    return safeSendMessage(chatId, '🐗 Хрю! Не могу прочитать таблицу, не задан GOOGLE_SCRIPT_URL!');
  }

  try {
    const tableDataResponse = await axiosClient.get(scriptUrl);
    const historyData = tableDataResponse.data;

    const groqKey = process.env.GROQ_API_KEY ? process.env.GROQ_API_KEY.trim() : '';
    const analyticsAiResponse = await axiosClient.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
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
    
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const imageResponse = await axios.get(fileUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000 
    });
    
    const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');
    const captionText = msg.caption ? `Подпись от пользователя к фото: "${msg.caption}"` : 'Подписи нет.';

    const groqKey = process.env.GROQ_API_KEY ? process.env.GROQ_API_KEY.trim() : '';
    const visionResponse = await axiosClient.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'qwen/qwen3.6-27b',
        reasoning_format: 'hidden',
        messages: [
          {
            role: 'system',
            content: `Верни СТРОГО валидный JSON в таком формате, без лишнего текста и без блоков кода:
{
  "items": [
    {
      "name": "название на русском",
      "price": число,
      "category": "Категория",
      "type": "Общий"
    }
  ]
}

Категории: Продукты, Бухло, Вкусняшки кабаньи, Транспорт, Жилье и Коммуналка, Развлечения и Отдых, Здоровье и Аптека, Покупки и Шмотки, Кафе и Рестораны, Подарки и Донаты.
Тип: "Личный" или "Общий".

ПРАВИЛА ДЛЯ ВЬЕТНАМСКИХ ЧЕКОВ (VND):
Точки и запятые — это разделители тысяч (7.000 = 7 000, а не 7 миллионов). Вода, кофе и мелкие продукты не стоят миллионы.`
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
    
    let rawContent = visionResponse.data.choices[0].message.content.trim();
    
    rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    rawContent = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
    
    const data = JSON.parse(rawContent);
    
    if (data.items && data.items.length > 0) {
      for (const item of data.items) {
        let fixedPrice = Number(item.price) || 0;
        const lowerName = (item.name || '').toLowerCase();

        const isSmallItem = lowerName.includes('вод') || lowerName.includes('water') || lowerName.includes('minh') || 
                            lowerName.includes('кофе') || lowerName.includes('чай') || lowerName.includes('снек') || 
                            lowerName.includes('чипсы') || lowerName.includes('пиво') || lowerName.includes('хлеб');

        if (isSmallItem && fixedPrice > 500000) {
          fixedPrice = fixedPrice / 1000;
          console.log(`--- КАБАН ПЕРЕХВАТИЛ АБСУРДНУЮ ЦЕНУ: исправлено с ${item.price} на ${fixedPrice} для "${item.name}" ---`);
        } else if (fixedPrice > 10000000) {
          fixedPrice = fixedPrice / 1000;
        }

        await processExpense(msg, {
          amount: fixedPrice,
          category: item.category || 'Продукты',
          description: item.name || 'Товар с чека',
          type: item.type || 'Общий'
        });
      }
    } else {
      safeSendMessage(chatId, '🐗 Кабан присмотрелся, но не разглядел позиций на чеке.');
    }

  } catch (error) {
    console.error('Ошибка обработки фото:', error.response?.data || error.message);

    if (error.response?.data?.error?.code === 'rate_limit_exceeded') {
      return safeSendMessage(
        chatId, 
        '🐗 *Кабан слишком быстро разглядывал чеки!* Лимит нейросети превышен.\n\nПодожди 15 секунд и отправь чек снова!', 
        { parse_mode: 'Markdown' }
      );
    }

    safeSendMessage(chatId, '🐗 Упс! Кабан не смог разобрать чек. Попробуй сделать фото четче или отправь текстом.');
  }
});

// Обработчик инлайн-кнопок
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const messageId = query.message.message_id;

  // Мгновенно гасим часики на кнопке в Telegram
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
  } else if (query.data === 'DELETE_LAST') {
    // ПРОВЕРКА LOCK-ЗАЩИТЫ: Если эта кнопка уже нажимается — игнорируем повторный клик!
    if (pendingDeletions.has(messageId)) {
      console.log(`⚠️ Попытка повторного клика по сообщению ${messageId} заблокирована.`);
      return;
    }

    // Блокируем сообщение от повторных кликов
    pendingDeletions.add(messageId);

    // МГНОВЕННО УБИРАЕМ КНОПКУ из сообщения
    try {
      await bot.editMessageText('⏳ *Удаляю трату из таблицы...*', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });
    } catch (e) {}

    // Запускаем процесс точечного удаления
    await handleDeleteLast(chatId, userId, messageId);
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
            { text: '🇷🇺 Рубли (RUB)', callback_data: 'CURRENCY_RUB' },
            { text: '🇻🇳 Донги (VND)', callback_data: 'CURRENCY_VND' },
            { text: '🇹🇭 Баты (THB)', callback_data: 'CURRENCY_THB' }
          ]
        ]
      }
    };
    return safeSendMessage(chatId, 'Выбери валюту для ввода трат:', options);
  }

  // 3. Кнопка «Изменить курс»
  if (text === '⚙️ Изменить курс' || text === '/setrate') {
    const currentCurr = userCurrencies[chatId] || 'RUB';

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
    return handleDeleteLast(chatId, userId);
  }

  // 6. Обычный ввод траты или команда
  if (!text.startsWith('/')) {
    try {
      console.log(`[ТЕКСТ ВХОД]: "${text}"`);
      const groqKey = process.env.GROQ_API_KEY ? process.env.GROQ_API_KEY.trim() : '';

      // Единый AI-запрос
      const singleAiResponse = await axiosClient.post(
        '[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)',
        {
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: `Ты — умный модуль распознавания финансовых трат.
Разбери сообщение пользователя и верни СТРОГО JSON-объект без пояснений.

ФОРМАТ JSON:
{
  "intent": "add_expense" | "delete" | "analytics",
  "amount": число_или_null,
  "category": "Категория",
  "description": "Описание траты на русском",
  "type": "Общий" | "Личный"
}

ПРАВИЛА ОПРЕДЕЛЕНИЯ ИНТЕНТА:
- "delete": если просит отменить/удалить (например: "удали", "отмени", "ошибка", "убери").
- "analytics": если просит статистику/анализ/вопрос по деньгам (например: "сколько потратили", "анализ", "отчет").
- "add_expense": во всех остальных случаях (ввод траты).

ПРАВИЛА ИЗВЛЕЧЕНИЯ ДАННЫХ ДЛЯ add_expense:
1. amount: Извлеки чистое число траты. Пробелы в тысячах (например 100 000) или точки (100.000) превращай в обычное число 100000.
2. category: Одна из: Продукты, Бухло, Вкусняшки кабаньи, Транспорт, Жилье и Коммуналка, Развлечения и Отдых, Здоровье и Аптека, Покупки и Шмотки, Кафе и Рестораны, Подарки и Донаты.
3. type: "Личный" (если есть "себе", "мне", "личный", или шмотки/аптека) иначе "Общий".
4. description: Короткое понятное название на русском.`
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

      let parsed = {};
      try {
        parsed = JSON.parse(singleAiResponse.data.choices[0].message.content);
        console.log('[AI РЕЗУЛЬТАТ]:', parsed);
      } catch (e) {
        console.error('Ошибка парсинга JSON от Groq:', e.message);
      }

      // Перенаправление интентов
      if (parsed.intent === 'analytics') {
        return handleAnalytics(msg);
      }
      if (parsed.intent === 'delete') {
        return handleDeleteLast(chatId, userId);
      }

      // Достаем число
      let finalAmount = Number(parsed.amount || parsed.price);

      // ЖЕЛЕЗНЫЙ РЕЗЕРВНЫЙ ПАРСЕР ЧИСЕЛ (Фоллбэк через регулярку Node.js)
      if (isNaN(finalAmount) || finalAmount <= 0) {
        console.log('⚠️ AI не смог вытащить amount, включаем Резервный Парсер...');
        const cleanedText = text.replace(/(\d+)\s+(\d{3})/g, '$1$2').replace(',', '.');
        const match = cleanedText.match(/\d+(\.\d+)?/);
        if (match) {
          finalAmount = parseFloat(match[0]);
          console.log(`[РЕЗЕРВНЫЙ ПАРСЕР УСПЕХ]: извлечено число ${finalAmount}`);
        }
      }

      // Если цифры нет вообще
      if (isNaN(finalAmount) || finalAmount <= 0) {
        return safeSendMessage(
          chatId, 
          '🐗 Кабан не нашёл сумму в сообщении. Напиши цифрами, например: `Такси 300` или `50000 фо бо`.', 
          { parse_mode: 'Markdown' }
        );
      }

      let description = parsed.description || text.replace(/\d+/g, '').trim() || 'Трата';

      await processExpense(msg, {
        amount: finalAmount,
        category: parsed.category || 'Продукты',
        description: description,
        type: parsed.type || 'Общий'
      });

    } catch (error) {
      console.error('--- ОШИБКА ОБРАБОТКИ ТЕКСТА ---', error.response?.data || error.message);
      
      // Спасаем трату через Резервный Парсер даже при краше сети
      const cleanedText = text.replace(/(\d+)\s+(\d{3})/g, '$1$2').replace(',', '.');
      const match = cleanedText.match(/\d+(\.\d+)?/);
      
      if (match) {
        const fallbackAmount = parseFloat(match[0]);
        console.log(`[CRASH FALLBACK SUCCESS]: Вытащили ${fallbackAmount} без участия AI`);
        return await processExpense(msg, {
          amount: fallbackAmount,
          category: 'Продукты',
          description: text.replace(/\d+/g, '').trim() || 'Трата',
          type: 'Общий'
        });
      }

      safeSendMessage(chatId, '🐗 Упс! Не смог найти сумму. Напиши, например: `Такси 300`.');
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
    console.log('⚠️ [Сбой TLS/Сети]: Запрос был отменен сетевым фильтром (переподключение...)');
  } else {
    console.error('⚠️ [НЕОБРАБОТАННЫЙ ПРОМИС]:', errorMessage);
  }
});

console.log('Бот "Кабан Финансист" успешно запущен и готов к деплою!');
