require('dotenv').config();

const config = {
  database: {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT) || 5432,
    max: 20, // максимальное количество соединений в пуле
    idleTimeoutMillis: 30000, // время простоя соединения
    connectionTimeoutMillis: 2000, // время ожидания соединения
  },
  bitrix24: {
    webhookBase: process.env.BITRIX24_WEBHOOK_BASE,
    domain: process.env.BITRIX24_DOMAIN || 'colife-invest.bitrix24.ru',
    userId: process.env.BITRIX24_USER_ID,
    webhookToken: process.env.BITRIX24_WEBHOOK_TOKEN,
  },
  server: {
    port: parseInt(process.env.PORT) || 3001,
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  sync: {
    dealsInterval: parseInt(process.env.DEALS_SYNC_INTERVAL) || 1000 * 60 * 60, // 1 час
    phonesInterval: parseInt(process.env.PHONES_SYNC_INTERVAL) || 1000 * 60 * 60 * 24, // 24 часа
    batchSize: parseInt(process.env.BATCH_SIZE) || 50,
    delayBetweenRequests: parseInt(process.env.DELAY_BETWEEN_REQUESTS) || 200,
  }
};

// Валидация конфигурации
function validateConfig() {
  const required = [
    'DB_USER', 'DB_HOST', 'DB_NAME', 'DB_PASSWORD',
    'BITRIX24_WEBHOOK_BASE'
  ];
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  if (!config.bitrix24.webhookBase.endsWith('/')) {
    config.bitrix24.webhookBase += '/';
  }
  
  console.log('✅ Configuration validated successfully');
  return config;
}

module.exports = { config, validateConfig };
