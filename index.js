const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { config, validateConfig } = require("./config");
const SyncService = require("./services/sync");
const DatabaseService = require("./services/database");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Инициализация сервисов
let syncService, dbService;

// Валидация конфигурации
try {
  validateConfig();
  dbService = new DatabaseService();
  syncService = new SyncService(dbService); // Передаем экземпляр DatabaseService
} catch (error) {
  console.error('❌ Configuration error:', error.message);
  process.exit(1);
}

app.use(express.static("public"));
app.get("/", (req, res) => res.sendFile(__dirname + "/public/index.html"));

// Функции загрузки данных теперь используют SyncService
async function loadPipelines() {
  try {
    await syncService.loadPipelines();
  } catch (err) {
    console.error("Ошибка загрузки воронок:", err.message);
  }
}

async function loadStages() {
  try {
    await syncService.loadStages();
  } catch (err) {
    console.error("Ошибка загрузки стадий:", err.message);
  }
}

// Функция syncDealContacts теперь реализована в SyncService

// Функция normalizePhones теперь реализована в SyncService

// Функция delay теперь реализована в SyncService

async function loadContactsBatch(contactIds) {
  try {
    await syncService.loadContactsBatch(contactIds);
  } catch (err) {
    console.error("Ошибка пакетной загрузки контактов:", err.message);
  }
}

async function loadDeals(start = 0, manual = false) {
  try {
    await syncService.loadDeals(start, manual);
    if (manual) io.emit("load-complete", { success: true });
  } catch (err) {
    console.error("Ошибка загрузки сделок:", err.message);
    if (manual) io.emit("load-complete", { success: false, error: err.message });
  }
}



// ==== WebSocket ====
io.on("connection", (socket) => {
  console.log("New client connected (socket.id):", socket.id);

  socket.on("manual-load", async () => {
    console.log("Manual load triggered by client", socket.id);
    try {
      await loadDeals(0, true);
      // loadDeals уже отправляет io.emit("load-complete"), дублировать не нужно
      console.log("Manual load complete");
    } catch (err) {
      console.error("Error in manual-load:", err);
      socket.emit("load-complete", { success: false, error: err.message });
    }
  });
  sendFilters(socket); // При подключении сразу отправляем фильтры

  socket.on("load-page", async ({ page, pipelineId, stageId, search }) => {
    try {
      // Валидация входных данных
      const validatedPage = Math.max(1, parseInt(page) || 1);
      const validatedPipelineId = pipelineId && !isNaN(Number(pipelineId)) ? Number(pipelineId) : null;
      const validatedStageId = stageId && !isNaN(Number(stageId)) ? Number(stageId) : null;
      const validatedSearch = typeof search === 'string' ? search.trim() : '';

      const filters = { 
        pipelineId: validatedPipelineId, 
        stageId: validatedStageId, 
        search: validatedSearch 
      };
      
      const result = await dbService.getDealsWithFilters(filters, validatedPage, 100);
      
      socket.emit("total-count", result.total);
      socket.emit("page-data", result.data);
    } catch (err) {
      console.error("Ошибка загрузки страницы:", err.message);
      socket.emit("page-data", []);
      socket.emit("total-count", 0);
    }
  });

  socket.on("validate-phones", async () => {
    try {
      // Используем метод сервиса вместо прямого доступа к pool
      const allContactIds = await dbService.getAllContactIds();
      console.log(
        `🔍 Проверка телефонов для ${allContactIds.length} контактов...`
      );
      await loadContactsBatch(allContactIds);
      socket.emit("phones-validated", { success: true });
    } catch (err) {
      console.error("Ошибка при проверке телефонов:", err.message);
      socket.emit("phones-validated", { success: false, error: err.message });
    }
  });

  socket.on("load-contacts", async () => {
    console.log("Server: load-contacts received from socket.id=", socket.id);
    try {
      const contacts = await dbService.getAllContacts();
      socket.emit("contacts-data", contacts);
    } catch (err) {
      console.error("Ошибка при load-contacts:", err);
      socket.emit("contacts-data", []);
    }
  });

  socket.on("delete-contact", async ({ contactId }) => {
    try {
      // Валидация входных данных
      if (!contactId || isNaN(Number(contactId))) {
        socket.emit("delete-result", {
          success: false,
          message: "Некорректный ID контакта",
        });
        return;
      }

      // Используем метод сервиса
      const result = await dbService.deleteContact(Number(contactId));
      socket.emit("delete-result", result);
    } catch (err) {
      console.error("Ошибка при delete-contact:", err.message);
      socket.emit("delete-result", { success: false, message: err.message });
    }
  });
});

// Отдельная функция отправки фильтров
async function sendFilters(socket) {
  try {
    const filters = await dbService.getFilters();
    socket.emit("filters", filters);
  } catch (err) {
    console.error("Ошибка загрузки фильтров:", err.message);
    socket.emit("filters", { pipelines: [], stages: [] });
  }
}

// ==== Старт синхронизации ====
async function startupSync() {
  try {
    await syncService.startupSync();
  } catch (error) {
    console.error("❌ Ошибка запуска синхронизации:", error.message);
  }
}

function runScheduledJobs() {
  let dealsInterval, phonesInterval;
  
  // 1. Автообновление сделок раз в час
  dealsInterval = setInterval(async () => {
    try {
      console.log("⏰ Автосинхронизация сделок...");
      await loadDeals(0, false);
      console.log("✅ Автосинхронизация завершена.");
    } catch (err) {
      console.error("❌ Ошибка автосинхронизации сделок:", err.message);
      // Останавливаем интервал при критических ошибках
      if (err.message.includes('Database connection failed')) {
        clearInterval(dealsInterval);
        console.error("🛑 Остановлен интервал синхронизации сделок из-за ошибки БД");
      }
    }
  }, config.sync.dealsInterval);

  // 2. Проверка телефонов раз в сутки
  phonesInterval = setInterval(async () => {
    try {
      console.log("⏰ Автоматическая проверка телефонов...");
      const allContactIds = await dbService.getAllContactIds();
      await loadContactsBatch(allContactIds);
      console.log("✅ Автоматическая проверка телефонов завершена.");
    } catch (err) {
      console.error(
        "❌ Ошибка автоматической проверки телефонов:",
        err.message
      );
      // Останавливаем интервал при критических ошибках
      if (err.message.includes('Database connection failed')) {
        clearInterval(phonesInterval);
        console.error("🛑 Остановлен интервал проверки телефонов из-за ошибки БД");
      }
    }
  }, config.sync.phonesInterval);

  // Возвращаем интервалы для возможности остановки
  return { dealsInterval, phonesInterval };
}

const PORT = config.server.port;
let scheduledJobs;

server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT} в режиме ${config.server.nodeEnv}`);
  startupSync();
  scheduledJobs = runScheduledJobs();
});

// Обработка ошибок сервера
server.on('error', (error) => {
  if (error.syscall !== 'listen') {
    throw error;
  }

  switch (error.code) {
    case 'EACCES':
      console.error(`❌ Порт ${PORT} требует повышенных привилегий`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(`❌ Порт ${PORT} уже используется`);
      process.exit(1);
      break;
    default:
      throw error;
  }
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`🛑 Получен сигнал ${signal}, закрываем сервер...`);
  
  try {
    // Останавливаем запланированные задачи
    if (scheduledJobs) {
      if (scheduledJobs.dealsInterval) clearInterval(scheduledJobs.dealsInterval);
      if (scheduledJobs.phonesInterval) clearInterval(scheduledJobs.phonesInterval);
      console.log('⏹️ Запланированные задачи остановлены');
    }
    
    // Закрываем сервисы
    if (syncService) await syncService.close();
    
    // Закрываем сервер
    server.close(() => {
      console.log('✅ Сервер успешно закрыт');
      process.exit(0);
    });
    
    // Таймаут на принудительное закрытие
    setTimeout(() => {
      console.error('❌ Принудительное закрытие из-за таймаута');
      process.exit(1);
    }, 10000);
    
  } catch (error) {
    console.error('❌ Ошибка при graceful shutdown:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
