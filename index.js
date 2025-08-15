const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pool = new Pool({
  user: "myuser",
  host: "localhost",
  database: "colife",
  password: "mypassword",
  port: 5432,
});

const webhookBase =
  "https://colife-invest.bitrix24.ru/rest/15013/wttyc87b4ysgoa1b/";

app.use(express.static("public"));
app.get("/", (req, res) => res.sendFile(__dirname + "/public/index.html"));

async function loadPipelines() {
  console.log("Загрузка воронок...");
  try {
    const response = await axios.post(`${webhookBase}crm.category.list`, {
      entityTypeId: 2,
    });
    const pipelines = response.data.result.categories;
    for (const p of pipelines) {
      await pool.query(
        "INSERT INTO pipelines (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
        [p.id, p.name]
      );
    }
    console.log(`Загружено ${pipelines.length} воронок.`);
  } catch (err) {
    console.error("Ошибка загрузки воронок:", err.message);
  }
}

async function loadStages() {
  console.log("Загрузка стадий...");
  try {
    const mainStages = await axios.get(`${webhookBase}crm.status.list`, {
      params: { filter: { ENTITY_ID: "DEAL_STAGE" } },
    });
    for (const s of mainStages.data.result) {
      await pool.query(
        "INSERT INTO stages (stage_id, stage_name, pipeline_id) VALUES ($1, $2, $3) ON CONFLICT (stage_id) DO UPDATE SET stage_name = EXCLUDED.stage_name, pipeline_id = EXCLUDED.pipeline_id",
        [s.STATUS_ID, s.NAME, 0]
      );
    }

    const pipelines = await pool.query(
      "SELECT id FROM pipelines WHERE id != 0"
    );
    for (const pipe of pipelines.rows) {
      const response = await axios.get(`${webhookBase}crm.status.list`, {
        params: { filter: { ENTITY_ID: `DEAL_STAGE_${pipe.id}` } },
      });
      for (const s of response.data.result) {
        await pool.query(
          "INSERT INTO stages (stage_id, stage_name, pipeline_id) VALUES ($1, $2, $3) ON CONFLICT (stage_id) DO UPDATE SET stage_name = EXCLUDED.stage_name, pipeline_id = EXCLUDED.pipeline_id",
          [s.STATUS_ID, s.NAME, pipe.id]
        );
      }
    }

    console.log("Все стадии загружены.");
  } catch (err) {
    console.error("Ошибка загрузки стадий:", err.message);
  }
}

async function syncDealContacts(dealId) {
  try {
    console.log(`syncDealContacts: start for deal ${dealId}`);
    // Запрос к Bitrix24
    const params = new URLSearchParams();
    params.append("id", dealId);

    const relResponse = await axios.post(
      `${webhookBase}crm.deal.contact.items.get`,
      params,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    // Логируем полный ответ:
    console.log(
      `Bitrix response for deal ${dealId}:`,
      JSON.stringify(relResponse.data)
    );

    // Проверяем поля
    if (!relResponse.data || typeof relResponse.data !== "object") {
      console.warn(
        `syncDealContacts: Unexpected response structure for deal ${dealId}`
      );
    }
    const rels = Array.isArray(relResponse.data.result)
      ? relResponse.data.result
      : [];
    console.log(
      `syncDealContacts: found ${rels.length} relations for deal ${dealId}`
    );

    // Удаляем старые связи для этой сделки
    const delRes = await pool.query(
      "DELETE FROM deal_contacts WHERE deal_id = $1 RETURNING *",
      [dealId]
    );
    console.log(
      `syncDealContacts: deleted previous ${delRes.rowCount} relations for deal ${dealId}`
    );

    let primaryId = null;
    for (const rel of rels) {
      // Проверяем, что rel.CONTACT_ID существует и корректен
      if (!rel.CONTACT_ID) {
        console.warn(
          `syncDealContacts: relation item missing CONTACT_ID for deal ${dealId}:`,
          rel
        );
        continue;
      }
      const contactId = Number(rel.CONTACT_ID);
      // 1) Проверяем, есть ли контакт в локальной БД:
      const exist = await pool.query("SELECT 1 FROM contacts WHERE id=$1", [
        contactId,
      ]);
      if (exist.rows.length === 0) {
        console.log(
          `syncDealContacts: контакт ${contactId} не найден, загружаем...`
        );
        // загрузить его сразу:
        await loadContactsBatch([contactId]);
      }
      if (isNaN(contactId)) {
        console.warn(
          `syncDealContacts: invalid CONTACT_ID for deal ${dealId}:`,
          rel.CONTACT_ID
        );
        continue;
      }
      // Если API возвращает строковые числа, парсим
      const sortIndex = rel.SORT != null ? parseInt(rel.SORT, 10) : null;
      let roleId = null;
      if (rel.ROLE_ID != null) {
        const parsed = parseInt(rel.ROLE_ID, 10);
        if (!isNaN(parsed) && parsed > 0) {
          roleId = parsed;
        }
      }
      const isPrimary =
        rel.IS_PRIMARY === "Y" ||
        rel.IS_PRIMARY === true ||
        rel.IS_PRIMARY === "true";
      if (isPrimary) primaryId = contactId;
      // Лог перед вставкой
      console.log(
        `syncDealContacts: inserting relation deal ${dealId} - contact ${contactId}, isPrimary=${isPrimary}, sort=${sortIndex}, role=${roleId}`
      );
      console.log(
        `syncDealContacts: inserting relation deal ${dealId} - contact ${contactId}, isPrimary=${isPrimary}, sort=${sortIndex}, role=${roleId}`
      );
      try {
        const res = await pool.query(
          `INSERT INTO deal_contacts
     (deal_id, contact_id, is_primary, sort_index, role_id, updated_at)
   VALUES ($1, $2, $3, $4, $5, NOW())
   ON CONFLICT (deal_id, contact_id) DO UPDATE SET
     is_primary = EXCLUDED.is_primary,
     sort_index = EXCLUDED.sort_index,
     role_id = EXCLUDED.role_id,
     updated_at = NOW()`,
          [dealId, contactId, isPrimary, sortIndex, roleId]
        );
        console.log(`syncDealContacts: insert/update rowCount=${res.rowCount}`);
      } catch (err) {
        console.error(
          `syncDealContacts: ошибка при вставке связи deal ${dealId}, contact ${contactId}:`,
          err.stack || err
        );
      }
    }
    console.log(
      `syncDealContacts: finished inserting relations for deal ${dealId}, primaryId=${primaryId}`
    );
    const contactIds = rels
      .map((r) => Number(r.CONTACT_ID))
      .filter((id) => !isNaN(id));
    return { contactIds, primaryId };
  } catch (err) {
    console.error(
      `Ошибка syncDealContacts для сделки ${dealId}:`,
      err.response?.data || err.message
    );
    return { contactIds: [], primaryId: null };
  }
}

function normalizePhones(rawPhones) {
  const seen = new Set();
  const result = [];

  for (const p of rawPhones || []) {
    const orig = p.VALUE;
    const digits = orig.replace(/\D/g, "");
    if (!digits) continue;

    const norm = "+" + digits;

    // если уже такой был — дубликат, удаляем
    if (seen.has(norm)) {
      if (p.ID) {
        result.push({ ID: p.ID, OPERATION: "DELETE" });
      }
      continue;
    }

    seen.add(norm);

    // если формат отличается — удаляем старый и добавляем новый без ID
    if (orig !== norm && p.ID) {
      result.push({ ID: p.ID, OPERATION: "DELETE" });
      result.push({ VALUE: norm, VALUE_TYPE: p.VALUE_TYPE || "WORK" });
    } else {
      result.push({ VALUE: norm, VALUE_TYPE: p.VALUE_TYPE || "WORK" });
    }
  }

  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadContactsBatch(contactIds) {
  if (contactIds.length === 0) return;
  const chunk = contactIds.slice(0, 50);
  try {
    const response = await axios.get(`${webhookBase}crm.contact.list`, {
      params: {
        select: ["ID", "NAME", "PHONE"],
        filter: { "@ID": chunk },
      },
    });

    for (const contact of response.data.result) {
      const name = contact.NAME || "";
      const link = `https://colife-invest.bitrix24.ru/crm/contact/details/${contact.ID}/`;

      const normalizedPhones = normalizePhones(contact.PHONE);
      const firstValidPhone =
        normalizedPhones.find((p) => !p.OPERATION)?.VALUE || null;

      // Обновляем в Bitrix24, если отличается
      if (JSON.stringify(contact.PHONE) !== JSON.stringify(normalizedPhones)) {
        let updated = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await axios.post(`${webhookBase}crm.contact.update`, {
              id: contact.ID,
              fields: {
                PHONE: normalizedPhones,
              },
            });
            updated = true;
            break;
          } catch (updateErr) {
            if (updateErr.response?.status === 503) {
              console.warn(
                `⏳ Попытка ${attempt} — Bitrix 503, ждём 2 сек... (Контакт ${contact.ID})`
              );
              await delay(2000);
            } else {
              console.error(
                `❌ Ошибка обновления контакта ${contact.ID} в Bitrix:`,
                updateErr.message
              );
              break;
            }
          }
        }

        if (!updated) {
          console.error(
            `❌ Все попытки обновить контакт ${contact.ID} не увенчались успехом.`
          );
        }
      }

      // Записываем в базу
      await pool.query(
        `INSERT INTO contacts (id, contact_name, phone, link)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           contact_name = EXCLUDED.contact_name,
           phone = EXCLUDED.phone,
           link = EXCLUDED.link`,
        [contact.ID, name, firstValidPhone, link]
      );
    }
  } catch (err) {
    console.error("Ошибка пакетной загрузки контактов:", err.message);
  }
}

async function loadDeals(start = 0, manual = false) {
  try {
    console.log(`Загрузка сделок... start = ${start}`);
    const response = await axios.get(`${webhookBase}crm.deal.list`, {
      params: {
        select: ["ID", "TITLE", "STAGE_ID", "CATEGORY_ID", "CONTACT_ID"],
        order: { ID: "ASC" },
        start: start,
      },
    });
    const deals = response.data.result;
    console.log(`Получено ${deals.length} сделок на странице start=${start}`);
    if (!deals.length) {
      console.log("Нет новых сделок для загрузки.");
      if (manual) io.emit("load-complete");
      return;
    }

    const contactIdsToLoad = new Set();
    for (const deal of deals) {
      console.log(`loadDeals: processing deal ID=${deal.ID}`);
      // вставка/обновление deals как у вас
      const dealLink = `https://colife-invest.bitrix24.ru/crm/deal/details/${deal.ID}/`;
      const existing = await pool.query(
        "SELECT deal_id FROM deals WHERE deal_id = $1",
        [deal.ID]
      );
      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO deals 
             (deal_id, title, current_stage_id, pipeline_id, contact_id, link)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (deal_id) DO UPDATE SET
             title = EXCLUDED.title,
             current_stage_id = EXCLUDED.current_stage_id,
             pipeline_id = EXCLUDED.pipeline_id,
             contact_id = EXCLUDED.contact_id,
             link = EXCLUDED.link,
             updated_at = NOW()`,
          [deal.ID, deal.TITLE, deal.STAGE_ID, deal.CATEGORY_ID, deal.CONTACT_ID, dealLink]
        );
      } else {
        await pool.query(
          `UPDATE deals 
             SET title=$1, current_stage_id=$2, pipeline_id=$3, contact_id=$4, link=$5, updated_at=NOW()
           WHERE deal_id=$6`,
          [deal.TITLE, deal.STAGE_ID, deal.CATEGORY_ID, deal.CONTACT_ID, dealLink, deal.ID]
        );
      }

      // синхронизация связей
      const { contactIds, primaryId } = await syncDealContacts(deal.ID);
      console.log(`loadDeals: syncDealContacts returned contactIds=${contactIds}, primaryId=${primaryId}`);
      for (const cid of contactIds) contactIdsToLoad.add(cid);
      if (primaryId) {
        await pool.query("UPDATE deals SET contact_id = $1 WHERE deal_id = $2", [primaryId, deal.ID]);
      }
      await delay(200);
    }

    // batch загрузка контактов
    const contactIdsArray = Array.from(contactIdsToLoad);
    for (let i = 0; i < contactIdsArray.length; i += 50) {
      const chunk = contactIdsArray.slice(i, i + 50);
      console.log("loadDeals: loading contacts batch", chunk);
      await loadContactsBatch(chunk);
      await delay(300);
    }

    // проверяем next
    const next = response.data.next;
    console.log(`Next for start=${start}:`, next);
    if (typeof next === "number" && next > 0) {
      await delay(500);
      await loadDeals(next, manual);
    } else {
      console.log("Все страницы сделок обработаны.");
      if (manual) io.emit("load-complete");
    }
  } catch (err) {
    console.error("Ошибка загрузки сделок:", err.response?.data || err.message);
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
      socket.emit("load-complete", { success: true });
      console.log("Manual load complete");
    } catch (err) {
      console.error("Error in manual-load:", err);
      socket.emit("load-complete", { success: false, error: err.message });
    }
  });
  sendFilters(socket); // При подключении сразу отправляем фильтры

  socket.on("load-page", async ({ page, pipelineId, stageId, search }) => {
    try {
      const limit = 100;
      const offset = (page - 1) * limit;
      const params = [];
      const filters = [];

      // Фильтр по воронке
      if (pipelineId) {
        params.push(pipelineId);
        filters.push(`d.pipeline_id = $${params.length}`);
      }
      // Фильтр по стадии
      if (stageId) {
        params.push(stageId);
        filters.push(`d.current_stage_id = $${params.length}`);
      }
      // Фильтр по поиску
      if (search) {
        // добавляем два параметра: для названия сделки и для имени контакта
        params.push(`%${search}%`);
        const idx1 = params.length; // первый placeholder для title
        params.push(`%${search}%`);
        const idx2 = params.length; // второй placeholder для contact_name
        // Здесь важно: оба placeholder должны быть вида $<число>, без лишних $
        filters.push(
          `(d.title ILIKE $${idx1} OR c.contact_name ILIKE $${idx2})`
        );
      }

      // --- Сначала делаем COUNT(*) ---
      let countQuery = `
      SELECT COUNT(*) AS total
      FROM deals d
      LEFT JOIN contacts c ON d.contact_id = c.id
    `;
      if (filters.length > 0) {
        countQuery += ` WHERE ${filters.join(" AND ")}`;
      }
      // Выполняем запрос COUNT с теми же params (без limit/offset)
      const countRes = await pool.query(countQuery, params);
      const total = Number(countRes.rows[0].total);
      // Шлём клиенту общее число
      socket.emit("total-count", total);

      // --- Далее делаем получение page-data ---
      // Собираем основной запрос на выборку строк
      let dataQuery = `
      SELECT
        d.deal_id,
        d.title,
        d.link AS deal_link,
        s.stage_name,
        p.name AS pipeline_name,
        c.phone,
        c.contact_name,
        c.link AS contact_link
      FROM deals d
      LEFT JOIN stages s ON d.current_stage_id = s.stage_id
      LEFT JOIN pipelines p ON d.pipeline_id = p.id
      LEFT JOIN contacts c ON d.contact_id = c.id
    `;
      if (filters.length > 0) {
        dataQuery += ` WHERE ${filters.join(" AND ")}`;
      }
      // Добавляем сортировку и пагинацию
      // Параметры limit и offset добавляем в конец массива params
      params.push(limit);
      params.push(offset);
      dataQuery += `
      ORDER BY d.pipeline_id DESC, s.stage_name DESC, d.deal_id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
      const result = await pool.query(dataQuery, params);

      // Шлём данные страницы
      socket.emit("page-data", result.rows);
    } catch (err) {
      console.error(
        "Ошибка загрузки страницы:",
        err.response?.data || err.message,
        err.stack
      );
      // Можно опционально шлёть клиенту ошибку:
      socket.emit("page-data", []);
      socket.emit("total-count", 0);
    }
  });

  socket.on("validate-phones", async () => {
    try {
      const res = await pool.query("SELECT id FROM contacts");
      const allContactIds = res.rows.map((r) => r.id);
      console.log(
        `🔍 Проверка телефонов для ${allContactIds.length} контактов...`
      );
      await loadContactsBatch(allContactIds); // повторно прогоняем форматирование
      socket.emit("phones-validated", { success: true });
    } catch (err) {
      console.error("Ошибка при проверке телефонов:", err.message);
      socket.emit("phones-validated", { success: false, error: err.message });
    }
  });

  socket.on("load-contacts", async () => {
    console.log("Server: load-contacts received from socket.id=", socket.id);
    try {
      const result = await pool.query(`
      SELECT 
        c.id, 
        c.contact_name, 
        c.phone, 
        c.link AS contact_link,
        COALESCE(array_agg(dc.deal_id) FILTER (WHERE dc.deal_id IS NOT NULL), '{}') AS deal_ids
      FROM contacts c
      LEFT JOIN deal_contacts dc ON c.id = dc.contact_id
      GROUP BY c.id, c.contact_name, c.phone, c.link
      ORDER BY c.contact_name NULLS LAST
    `);
      console.log(
        "Server: load-contacts query returned",
        result.rows.length,
        "rows"
      );
      if (result.rows.length > 0) {
        console.log("Server: sample rows:", result.rows.slice(0, 3));
      }
      socket.emit("contacts-data", result.rows);
    } catch (err) {
      console.error("Ошибка при load-contacts:", err);
      socket.emit("contacts-data", []);
    }
  });

  socket.on("delete-contact", async ({ contactId }) => {
    try {
      // Проверяем, есть ли связанные сделки
      const res = await pool.query(
        "SELECT 1 FROM deal_contacts WHERE contact_id = $1 LIMIT 1",
        [contactId]
      );
      if (res.rows.length > 0) {
        socket.emit("delete-result", {
          success: false,
          message: "Есть связанные сделки. Нельзя удалить.",
        });
      } else {
        // Удаляем из таблицы contacts
        await pool.query("DELETE FROM contacts WHERE id = $1", [contactId]);
        socket.emit("delete-result", { success: true, contactId });
      }
    } catch (err) {
      console.error("Ошибка при delete-contact:", err.message);
      socket.emit("delete-result", { success: false, message: err.message });
    }
  });
});

// Отдельная функция отправки фильтров
async function sendFilters(socket) {
  try {
    const pipelines = await pool.query(
      "SELECT id, name FROM pipelines ORDER BY name ASC"
    );

    const stages = await pool.query(
      "SELECT stage_id, stage_name, pipeline_id FROM stages ORDER BY pipeline_id ASC, stage_name ASC"
    );

    socket.emit("filters", {
      pipelines: pipelines.rows,
      stages: stages.rows,
    });
  } catch (err) {
    console.error("Ошибка загрузки фильтров:", err.message);
  }
}

// ==== Старт синхронизации ====
async function startupSync() {
  console.log("▶ Запуск параллельной загрузки справочников...");
  await Promise.all([loadPipelines(), loadStages()]);
  await loadDeals(0, true);
  console.log("✅ Все данные успешно загружены.");
}

function runScheduledJobs() {
  // 1. Автообновление сделок раз в час
  setInterval(async () => {
    try {
      console.log("⏰ Автосинхронизация сделок...");
      await loadDeals(0, false);
      console.log("✅ Автосинхронизация завершена.");
    } catch (err) {
      console.error("❌ Ошибка автосинхронизации сделок:", err.message);
    }
  }, 1000 * 60 * 60);

  // 2. Проверка телефонов раз в сутки
  setInterval(async () => {
    try {
      console.log("⏰ Автоматическая проверка телефонов...");
      const res = await pool.query("SELECT id FROM contacts");
      const allContactIds = res.rows.map((r) => r.id);
      await loadContactsBatch(allContactIds);
      console.log("✅ Автоматическая проверка телефонов завершена.");
    } catch (err) {
      console.error(
        "❌ Ошибка автоматической проверки телефонов:",
        err.message
      );
    }
  }, 1000 * 60 * 60 * 24);
}

server.listen(3001, () => {
  console.log("Сервер запущен на порту 3001");
  startupSync();
  runScheduledJobs(); // ← запуск фоновых задач
});
