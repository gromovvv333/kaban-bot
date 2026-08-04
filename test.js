const TelegramBot = require('node-telegram-bot-api');

// Замени на реальный токен из Telegram BotFather (без пробелов)
const token = '8846752500:AAHowlHvtUhVCUvnit6npSG3Slye8c7549Q'; 

console.log('Пробуем запустить бота напрямую...');

try {
  const bot = new TelegramBot(token, { polling: true });

  bot.on('message', (msg) => {
    console.log('Получено сообщение:', msg.text);
    bot.sendMessage(msg.chat.id, 'Кабан на связи!');
  });

  console.log('Бот успешно запущен и ждет сообщений!');
} catch (err) {
  console.error('Ошибка при запуске:', err);
}