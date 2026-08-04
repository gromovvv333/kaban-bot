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

// СЛОВАРЬ ПОЛЬЗОВАТЕЛЕЙ
const USERS = {
  336595543: 'Главный кабан',  // Твой Telegram ID
  333816615: 'Кабанка'         // Telegram ID Алисы
};

// Функция удаления последней траты из Google Таблицы
async function handleDeleteLast(chatId, userId, messageIdToEdit = null) {
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL ? process.env.GOOGLE_SCRIPT_URL.trim() : null;
  if (!scriptUrl) {
    return safeSendMessage(chatId, '🐗 Хрю! Не могу удалить запись, не задан GOOGLE_SCRIPT_URL!');
  }

  try {
    const res = await axiosClient.post(scriptUrl, {
      action: 'delete_last',
      telegramId: userId
    });

    console.log('Ответ от Google на удаление:', res.data);

    if (messageIdToEdit) {
      try {
        await bot.editMessageText('❌ *Эта трата была отменена.*', {
          chat_id: chatId,
          message_id: messageIdToEdit,
          parse_mode: 'Markdown'
        });
      } catch (e) {
        console.log('Не удалось отредактировать сообщение:', e.message);
      }
    } else {
      await safeSendMessage(chatId, '🗑 *Последняя трата успешно удалена из таблицы!*', { parse_mode: 'Markdown' });
    }
    console.log(`--- ПОСЛЕДНЯЯ ТРАТА УДАЛЕНА ПОЛЬЗОВАТЕЛЕМ ${userId} ---`);
  } catch (err) {
    console.error('Ошибка удаления записи из Google Таблицы:', err.response?.data || err.message);
    safeSendMessage(chatId, '🐗 Не удалось удалить последнюю запись. Проверь логи или таблицу!');
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
          'Authorization': `Bearer ${process.env.GROQ_API_KEY.trim()}`,
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
          'Authorization': `Bearer ${process.env.GROQ_API_KEY.trim()}`,
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

  const safeAnswer = async (text) => {
    try {
      await bot.answerCallbackQuery(query.id, { text });
    } catch (e) {
      console.log('Таймаут ответа на инлайн-кнопку (игнорируем):', e.message);
    }
  };

  if (query.data.startsWith('CURRENCY_')) {
    const currency = query.data.split('_')[1];
    userCurrencies[chatId] = currency;
    console.log('Установлена валюта для', chatId, ':', userCurrencies[chatId]);
    
    await safeAnswer(`Валюта изменена на ${currency}`);
    
    let rateInfo = '';
    if (currency === 'VND') {
      rateInfo = `\nТекущий делитель курса: **${rates.VND || 330}** (100 000 VND = ${(100000 / (rates.VND || 330)).toFixed(2)} ₽)`;
    } else if (currency === 'THB') {
      rateInfo = `\nТекущий делитель курса: **${rates.THB || 0.38}** (100 THB = ${(100 / (rates.THB || 0.38)).toFixed(2)} ₽)`;
    }

    await safeSendMessage(
      chatId,
      `🐗 Теперь вводи суммы в ${currency}. Кабан будет автоматически пересчитывать их в рубли!${rateInfo}`,
      { parse_mode: 'Markdown' }
    );
  } else if (query.data === 'DELETE_LAST') {
    await safeAnswer('Удаляю последнюю запись...');
    await handleDeleteLast(chatId, userId, query.message.message_id);
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

  // 6. Обычный ввод траты
  if (!text.startsWith('/')) {
    try {
      console.log(`Обрабатываем сообщение: "${text}"`);

      const intentResponse = await axiosClient.post(
        '[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)',
        {
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: 'Проанализий текст. Если пользователь хочет УДАЛИТЬ или ОТМЕНИТЬ последнюю трату (например: "отмени", "удали", "ошибка"), верни JSON: {"intent": "delete"}. Если вводит НОВУЮ ТРАТУ (например: "Пиво 300", "Такси 450 личный", "100000 фо бо"), верни JSON: {"intent": "add_expense"}. Если ЗАДАЕТ ВОПРОС, просит аналитику или статистику, верни JSON: {"intent": "analytics"}. Верни ТОЛЬКО JSON.'
            },
            { role: 'user', content: text }
          ],
          response_format: { type: 'json_object' }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY.trim()}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const intentData = JSON.parse(intentResponse.data.choices[0].message.content);

      if (intentData.intent === 'analytics') {
        return handleAnalytics(msg);
      }

      if (intentData.intent === 'delete') {
        return handleDeleteLast(chatId, userId);
      }

      const parseResponse = await axiosClient.post(
        '[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)',
        {
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: `Ты — ассистент по учету финансов. Распознай сумму, описание, категорию и ТИП ТРАТЫ ("Общий" или "Личный") из текста.

ПРАВИЛА ОПРЕДЕЛЕНИЯ ТИПА ("type"):
1. ЯВНЫЕ СЛОВА: Если есть слова "личный", "себе", "моё", "мне", "для меня" -> type: "Личный". Если есть слова "наш", "нам", "домой", "общий" -> type: "Общий".
2. ЛОГИКА ПО КАТЕГОРИЯМ (если нет явных слов):
   - "Покупки и Шмотки", "Здоровье и Аптека", "Подарки и Донаты" -> по умолчанию "Личный".
   - "Жилье и Коммуналка", "Продукты", "Кафе и Рестораны", "Развлечения и Отдых", "Транспорт", "Вкусняшки кабаньи", "Бухло" -> по умолчанию "Общий".

ПРАВИЛА КАТЕГОРИЗАЦИИ:
- "Кафе и Рестораны": ЛЮБАЯ готовая еда и напитки, фастфуд, стритфуд, кофе, заведения.
- "Продукты": ТОЛЬКО супермаркеты и сырые ингредиенты из магазина.
- "Бухло": ТОЛЬКО алкогольные напитки.
- "Вкусняшки кабаньи": Сладкое, чипсы, мороженое, десерты, снэки.
- "Транспорт": Такси, бензин, проезд, байк, аренда авто, метро, граб.
- "Жилье и Коммуналка": Отель, аренда, коммуналка, интернет, жилье.
- "Развлечения и Отдых": Билеты, кино, экскурсии, массаж, игры, парки.
- "Здоровье и Аптека": Лекарства, аптека, врачи, анализы.
- "Покупки и Шмотки": Одежда, обувь, техника, хозяйственные товары.
- "Подарки и Донаты": Подарки, чаевые, донаты.

ПРАВИЛА ПАРСИНГА:
1. Число из текста ВСЕГДА извлекается как amount.
2. Описание переводи на русский и нормализуй (например, "фо бо 100000" -> description: "Фо бо").

Верни ТОЛЬКО JSON вида: {"amount": число, "category": "строка", "description": "строка", "type": "Общий" или "Личный"}`
            },
            { role: 'user', content: text }
          ],
          response_format: { type: 'json_object' }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY.trim()}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const parsed = JSON.parse(parseResponse.data.choices[0].message.content);

      await processExpense(msg, {
        amount: parsed.amount,
        category: parsed.category,
        description: parsed.description,
        type: parsed.type || 'Общий'
      });

    } catch (error) {
      console.error('--- ОШИБКА ОБРАБОТКИ ---', error.response?.data || error.message);
      safeSendMessage(chatId, '🐗 Упс! Кабан запутался в цифрах и хрюкнул. Попробуй еще раз!');
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

