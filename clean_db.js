/**
 * Скрипт очистки локальной базы: удаляет из локальных таблиц deals и contacts записи,
 * которых нет в Bitrix24.
 *
 * Запускать вручную: node clean_db.js
 * Перед запуском убедитесь, что переменные pool и webhookBase корректны.
 */

const axios = require("axios");
const { Pool } = require("pg");

// Настройки подключения к БД: те же, что в вашем основном коде
const pool = new Pool({
  user: "myuser",
  host: "localhost",
  database: "colife",
  password: "mypassword",
  port: 5432,
});

// Базовый URL вашего вебхука Bitrix24
const webhookBase = "https://colife-invest.bitrix24.ru/rest/15013/wttyc87b4ysgoa1b/";

// Задержка между запросами к Bitrix API (ms)
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Получить все ID сделок из Bitrix24: пагинация по crm.deal.list.
 * Возвращает Set числовых ID.
 */
async function fetchAllRemoteDealIds() {
  console.log("Начинаем получение всех deal_id из Bitrix24...");
  const remoteIds = new Set();
  let start = 0;
  while (true) {
    try {
      // Bitrix24 API: метод crm.deal.list. Выбираем только поле ID.
      const response = await axios.get(`${webhookBase}crm.deal.list`, {
        params: {
          select: ["ID"],
          order: { ID: "ASC" },
          start: start,
        },
      });
      const data = response.data;
      if (!data.result || !Array.isArray(data.result) || data.result.length === 0) {
        console.log("Достигнут конец списка сделок.");
        break;
      }
      // Добавляем ID в Set
      for (const item of data.result) {
        // item.ID обычно строка или число; приводим к числу
        const id = Number(item.ID);
        if (!isNaN(id)) remoteIds.add(id);
      }
      console.log(`Получено ${remoteIds.size} уникальных deal_id (последний пакет ${data.result.length})`);
      // Определяем следующий старт: Bitrix возвращает в data.next или data.next_start?
      // В Bitrix24 REST, ответ может содержать поле 'next' или 'next_start'. Часто: response.data.next.
      if (data.next) {
        start = data.next;
      } else {
        // Если нет data.next, но size < порог, можно считать конец.
        // Иногда API: когда start + количество >= всего, result пуст.
        // Здесь выходим, т.к. следующего нет.
        break;
      }
      // Задержка, чтобы не перегрузить API
      await delay(300);
    } catch (err) {
      console.error("Ошибка при fetchAllRemoteDealIds:", err.message);
      // При ошибке: можно попытаться повторить после задержки, но здесь просто выходим или можно ретраить.
      console.log("Ожидаем 5 секунд и пробуем снова...");
      await delay(5000);
    }
  }
  console.log(`Всего получено remote deal IDs: ${remoteIds.size}`);
  return remoteIds;
}

/**
 * Получить все ID контактов из Bitrix24: пагинация по crm.contact.list.
 * Возвращает Set числовых ID.
 */
async function fetchAllRemoteContactIds() {
  console.log("Начинаем получение всех contact ID из Bitrix24...");
  const remoteIds = new Set();
  let start = 0;
  while (true) {
    try {
      const response = await axios.get(`${webhookBase}crm.contact.list`, {
        params: {
          select: ["ID"],
          order: { ID: "ASC" },
          start: start,
        },
      });
      const data = response.data;
      if (!data.result || !Array.isArray(data.result) || data.result.length === 0) {
        console.log("Достигнут конец списка контактов.");
        break;
      }
      for (const item of data.result) {
        const id = Number(item.ID);
        if (!isNaN(id)) remoteIds.add(id);
      }
      console.log(`Получено ${remoteIds.size} уникальных contact ID (последний пакет ${data.result.length})`);
      if (data.next) {
        start = data.next;
      } else {
        break;
      }
      await delay(300);
    } catch (err) {
      console.error("Ошибка при fetchAllRemoteContactIds:", err.message);
      console.log("Ожидаем 5 секунд и пробуем снова...");
      await delay(5000);
    }
  }
  console.log(`Всего получено remote contact IDs: ${remoteIds.size}`);
  return remoteIds;
}

/**
 * Удалить локальные сделки, которых нет в remoteDealIds.
 */
async function cleanLocalDeals(remoteDealIds) {
  console.log("Начинаем очистку локальных сделок...");
  // Выбираем все локальные deal_id
  const res = await pool.query("SELECT deal_id FROM deals");
  const localIds = res.rows.map(r => Number(r.deal_id)).filter(id => !isNaN(id));
  console.log(`В локальной БД найдено сделок: ${localIds.length}`);
  let delCount = 0;
  for (const id of localIds) {
    if (!remoteDealIds.has(id)) {
      // Удаляем связи в deal_contacts и запись в deals
      try {
        await pool.query("DELETE FROM deal_contacts WHERE deal_id = $1", [id]);
        await pool.query("DELETE FROM deals WHERE deal_id = $1", [id]);
        delCount++;
        if (delCount % 50 === 0) {
          console.log(`Удалено локальных сделок: ${delCount}`);
        }
      } catch (err) {
        console.error(`Ошибка при удалении сделки ${id}:`, err.message);
      }
    }
  }
  console.log(`Очистка локальных сделок завершена. Удалено: ${delCount}`);
}

/**
 * Удалить локальные контакты, которых нет в remoteContactIds.
 * При удалении проверяем отсутствие связей в deal_contacts.
 */
async function cleanLocalContacts(remoteContactIds) {
  console.log("Начинаем очистку локальных контактов...");
  const res = await pool.query("SELECT id FROM contacts");
  const localIds = res.rows.map(r => Number(r.id)).filter(id => !isNaN(id));
  console.log(`В локальной БД найдено контактов: ${localIds.length}`);
  let delCount = 0;
  for (const id of localIds) {
    if (!remoteContactIds.has(id)) {
      try {
        // Проверяем связи: возможно, локально остались связи с ранее удалёнными сделками, но после cleanLocalDeals они уже удалены.
        const rel = await pool.query(
          "SELECT 1 FROM deal_contacts WHERE contact_id = $1 LIMIT 1",
          [id]
        );
        if (rel.rows.length === 0) {
          await pool.query("DELETE FROM contacts WHERE id = $1", [id]);
          delCount++;
          if (delCount % 50 === 0) {
            console.log(`Удалено локальных контактов: ${delCount}`);
          }
        } else {
          console.log(`Контакт ${id} имеет связи с делами, пропускаем`);
        }
      } catch (err) {
        console.error(`Ошибка при удалении контакта ${id}:`, err.message);
      }
    }
  }
  console.log(`Очистка локальных контактов завершена. Удалено: ${delCount}`);
}

/**
 * Основная функция: последовательно получает remote IDs и чистит локальные таблицы.
 */
async function main() {
  try {
    // 1. Получаем актуальные ID из Bitrix
    const remoteDealIds = await fetchAllRemoteDealIds();
    const remoteContactIds = await fetchAllRemoteContactIds();

    // 2. Удаляем локальные сделки, которых нет в Bitrix
    await cleanLocalDeals(remoteDealIds);

    // 3. Удаляем локальные контакты, которых нет в Bitrix
    await cleanLocalContacts(remoteContactIds);

    console.log("Очистка базы завершена.");
  } catch (err) {
    console.error("Ошибка в main:", err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

// Запуск
main();
