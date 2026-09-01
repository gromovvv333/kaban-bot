require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

console.log('Бот "Кабан Финансист" успешно запущен!');

bot.on('message', async (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    try {
      console.log('Обрабатываем сообщение:', msg.text);

      const groqUrl = 'https://api.groq.com/openai/v1/chat/completions?max_tokens=4096';

      const response = await axios.post(
        groqUrl,
        {
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: 'Ты — ассистент по учету финансов. Распознай сумму, категорию, описание и тип траты из текста пользователя. Категории должны строго соответствовать списку: Продукты - обычная еда, продукты питания, бакалея и напитки (кроме алкоголя и снеков), Бухло - любой алкоголь (пиво, водка, вино, коньяк и т.д.), Вкусняшки кабаньи - чипсы, сладости, конфеты, сухарики, снеки, вредный фастфуд, Транспорт - такси, общественный транспорт, метро, бензин, каршеринг, парковки, Жилье и Коммуналка - аренда, ЖКХ, интернет, связь, подписки на сервисы, Развлечения и Отдых - кино, бары (не пиво на дом), игры, хобби, концерты, Здоровье и Аптека - лекарства, врачи, анализы, спортзал, витамины, Покупки и Шмотки - одежда, обувь, гаджеты, товары для дома, Кафе и Рестораны - обеды в заведениях, готовая еда вне дома, Подарки и Донаты - подарки близким, праздники, чаевые, помощь. Верни ТОЛЬКО валидный JSON объект без markdown-тегов (без ```json) и без лишнего текста в формате: {"amount": число, "category": "строка", "description": "строка", "type": "Личный" или "Общий"}.',
            },
            {
              role: 'user',
              content: msg.text
            }
          ],
          response_format: { type: 'json_object' },
          reasoning_format: 'hidden'
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const aiResponse = response.data.choices[0].message.content;
      const data = JSON.parse(aiResponse);

      console.log('--- РАСПАРСЕННЫЕ ДАННЫЕ ---', data);

      const formattedMessage =
        `🐗 **Хрю! Кабан всё записал!**\n\n` +
        `💸 **Сумма:** ${data.amount} ₽\n` +
        `📂 **Категория:** ${data.category}\n` +
        `📝 **Описание:** ${data.description}\n` +
        `🏷 **Тип:** ${data.type}\n\n` +
        `📊 *Зарубил на носу и закинул в таблицу!*`;

      await bot.sendMessage(msg.chat.id, formattedMessage, { parse_mode: 'Markdown' });

      if (process.env.GOOGLE_SCRIPT_URL) {
        await axios.post(process.env.GOOGLE_SCRIPT_URL, data);
        console.log('--- УСПЕШНО ОТПРАВЛЕНО В GOOGLE ТАБЛИЦЫ ---');
      }

    } catch (error) {
      console.error('--- ОШИБКА ---', error.response?.data || error.message);
      bot.sendMessage(msg.chat.id, '🐗 *Упс! Кабан запутался в цифрах и хрюкнул. Попробуй еще раз!*', { parse_mode: 'Markdown' });
    }
  }
});