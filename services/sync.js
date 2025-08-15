const Bitrix24API = require('../utils/bitrix24');
const DatabaseService = require('./database');
const { config } = require('../config');

class SyncService {
  constructor(databaseService) {
    this.bitrix = new Bitrix24API();
    this.db = databaseService; // Принимаем экземпляр извне
    this.isSyncing = false;
    this.maxRecursionDepth = 10; // Ограничение рекурсии
    this.currentRecursionDepth = 0;
  }

  // Нормализация телефонных номеров
  normalizePhones(rawPhones) {
    // Защита от некорректных данных
    if (!Array.isArray(rawPhones)) {
      return [];
    }

    const seen = new Set();
    const result = [];

    for (const phone of rawPhones) {
      // Проверяем структуру объекта
      if (!phone || typeof phone !== 'object' || !phone.VALUE) {
        continue;
      }

      const orig = String(phone.VALUE);
      const digits = orig.replace(/\D/g, '');
      
      // Проверяем минимальную длину номера
      if (digits.length < 7) {
        continue;
      }

      const norm = '+' + digits;

      if (seen.has(norm)) {
        if (phone.ID) {
          result.push({ ID: phone.ID, OPERATION: 'DELETE' });
        }
        continue;
      }

      seen.add(norm);

      if (orig !== norm && phone.ID) {
        result.push({ ID: phone.ID, OPERATION: 'DELETE' });
        result.push({ VALUE: norm, VALUE_TYPE: phone.VALUE_TYPE || 'WORK' });
      } else {
        result.push({ VALUE: norm, VALUE_TYPE: phone.VALUE_TYPE || 'WORK' });
      }
    }

    return result;
  }

  // Загрузка воронок с очисткой удаленных
  async loadPipelines() {
    try {
      console.log('🔄 Загрузка воронок...');
      const response = await this.bitrix.getPipelines();
      const pipelines = response.result.categories;
      
      if (pipelines && pipelines.length > 0) {
        const columns = ['id', 'name'];
        const values = pipelines.map(p => [p.id, p.name]);
        
        // Получаем существующие ID воронок из БД
        const existingPipelines = await this.db.getPipelineIds();
        const existingIds = new Set(existingPipelines.map(p => p.id));
        const newIds = new Set(pipelines.map(p => p.id));
        
        // Находим удаленные воронки
        const deletedIds = existingIds.filter(id => !newIds.has(id));
        
        if (deletedIds.length > 0) {
          console.log(`🗑️ Удаляем ${deletedIds.length} удаленных воронок из БД`);
          await this.db.deletePipelines(deletedIds);
        }
        
        // Обновляем/добавляем существующие
        await this.db.batchInsert('pipelines', columns, values, ['id']);
        console.log(`✅ Загружено ${pipelines.length} воронок, удалено ${deletedIds.length} старых`);
      }
    } catch (error) {
      console.error('❌ Ошибка загрузки воронок:', error.message);
      throw error;
    }
  }

  // Загрузка стадий с очисткой удаленных
  async loadStages() {
    try {
      console.log('🔄 Загрузка стадий...');
      
      // Собираем все стадии из Bitrix24
      const allStages = [];
      
      // Основные стадии
      const mainStages = await this.bitrix.getStages('DEAL_STAGE');
      if (mainStages.result) {
        const mainStageValues = mainStages.result.map(s => [s.STATUS_ID, s.NAME, 0]);
        allStages.push(...mainStageValues);
      }

      // Стадии по воронкам
      const pipelines = await this.db.getPipelineIds();
      for (const pipe of pipelines) {
        try {
          const response = await this.bitrix.getStages(`DEAL_STAGE_${pipe.id}`);
          if (response.result) {
            const stageValues = response.result.map(s => [s.STATUS_ID, s.NAME, pipe.id]);
            allStages.push(...stageValues);
          }
        } catch (error) {
          console.warn(`⚠️ Не удалось загрузить стадии для воронки ${pipe.id}:`, error.message);
        }
        await this.delay(config.sync.delayBetweenRequests);
      }

      if (allStages.length > 0) {
        // Получаем существующие стадии из БД
        const existingStages = await this.db.getAllStageIds();
        const existingIds = new Set(existingStages.map(s => s.stage_id));
        const newIds = new Set(allStages.map(s => s[0]));
        
        // Находим удаленные стадии
        const deletedIds = existingIds.filter(id => !newIds.has(id));
        
        if (deletedIds.length > 0) {
          console.log(`🗑️ Удаляем ${deletedIds.length} удаленных стадий из БД`);
          await this.db.deleteStages(deletedIds);
        }
        
        // Обновляем/добавляем существующие
        const columns = ['stage_id', 'stage_name', 'pipeline_id'];
        await this.db.batchInsert('stages', columns, allStages, ['stage_id']);
        console.log(`✅ Загружено ${allStages.length} стадий, удалено ${deletedIds.length} старых`);
      }

      console.log('✅ Все стадии загружены');
    } catch (error) {
      console.error('❌ Ошибка загрузки стадий:', error.message);
      throw error;
    }
  }

  // Загрузка контактов batch
  async loadContactsBatch(contactIds) {
    if (contactIds.length === 0) return;

    try {
      const chunks = this.chunkArray(contactIds, config.sync.batchSize);
      let processedCount = 0;
      
      for (const chunk of chunks) {
        try {
          const response = await this.bitrix.getContacts(chunk);
          
          if (response.result) {
            const contacts = response.result.map(contact => {
              const normalizedPhones = this.normalizePhones(contact.PHONE);
              const firstValidPhone = normalizedPhones.find(p => !p.OPERATION)?.VALUE || null;
              
              return {
                ...contact,
                phone: firstValidPhone,
                link: this.bitrix.createEntityUrl('contact', contact.ID)
              };
            });

            // Обновляем контакты в Bitrix24 если нужно
            await this.updateContactsInBitrix(contacts);
            
            // Сохраняем в локальную БД
            await this.db.upsertContacts(contacts);
            
            processedCount += contacts.length;
          }
        } catch (chunkError) {
          console.error(`❌ Ошибка обработки chunk контактов:`, chunkError.message);
          // Продолжаем с следующим chunk'ом
          continue;
        }

        await this.delay(config.sync.delayBetweenRequests);
      }
      
      console.log(`✅ Обработано ${processedCount} контактов из ${contactIds.length}`);
    } catch (error) {
      console.error('❌ Критическая ошибка batch загрузки контактов:', error.message);
      throw error;
    }
  }

  // Обновление контактов в Bitrix24
  async updateContactsInBitrix(contacts) {
    const updatePromises = contacts.map(async (contact) => {
      const normalizedPhones = this.normalizePhones(contact.PHONE);
      if (JSON.stringify(contact.PHONE) !== JSON.stringify(normalizedPhones)) {
        try {
          await this.bitrix.updateContact(contact.ID, { PHONE: normalizedPhones });
        } catch (error) {
          console.warn(`⚠️ Не удалось обновить контакт ${contact.ID}:`, error.message);
        }
      }
    });

    // Используем Promise.allSettled для обработки всех результатов
    const results = await Promise.allSettled(updatePromises);
    
    // Логируем статистику обновлений
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    if (failed > 0) {
      console.warn(`⚠️ Обновление контактов: ${successful} успешно, ${failed} с ошибками`);
    }
  }

  // Загрузка сделок
  async loadDeals(start = 0, manual = false) {
    // Используем более надежную проверку состояния
    if (this.isSyncing) {
      console.log('⏳ Синхронизация уже выполняется, пропускаем...');
      return;
    }

    // Проверяем глубину рекурсии
    if (this.currentRecursionDepth >= this.maxRecursionDepth) {
      console.warn(`⚠️ Достигнута максимальная глубина рекурсии (${this.maxRecursionDepth}), останавливаем загрузку`);
      return;
    }

    // Устанавливаем флаг синхронизации
    this.isSyncing = true;
    this.currentRecursionDepth++;
    
    // Добавляем таймаут для защиты от зависания
    const syncTimeout = setTimeout(() => {
      if (this.isSyncing) {
        console.warn('⚠️ Синхронизация зависла, сбрасываем состояние');
        this.isSyncing = false;
        this.currentRecursionDepth = 0;
      }
    }, 300000); // 5 минут
    
    try {
      console.log(`🔄 Загрузка сделок... start = ${start}`);
      
      const response = await this.bitrix.getDeals(start);
      const deals = response.result;
      
      if (!deals || deals.length === 0) {
        console.log('ℹ️ Нет новых сделок для загрузки');
        return;
      }

      console.log(`📊 Получено ${deals.length} сделок на странице start=${start}`);

      // Подготавливаем сделки для batch вставки
      const preparedDeals = deals.map(deal => ({
        ...deal,
        link: this.bitrix.createEntityUrl('deal', deal.ID)
      }));

      // Batch вставка сделок
      await this.db.upsertDeals(preparedDeals);

      // Синхронизация связей сделка-контакт
      const contactIdsToLoad = new Set();
      
      for (const deal of deals) {
        try {
          const relations = await this.bitrix.getDealContacts(deal.ID);
          if (relations.result) {
            await this.db.upsertDealContacts(deal.ID, relations.result);
            
            // Собираем ID контактов для batch загрузки
            relations.result.forEach(rel => {
              if (rel.CONTACT_ID) {
                contactIdsToLoad.add(Number(rel.CONTACT_ID));
              }
            });
          }
        } catch (error) {
          console.warn(`⚠️ Ошибка синхронизации связей для сделки ${deal.ID}:`, error.message);
        }

        await this.delay(config.sync.delayBetweenRequests);
      }

      // Batch загрузка контактов
      if (contactIdsToLoad.size > 0) {
        console.log(`👥 Загружаем ${contactIdsToLoad.size} связанных контактов...`);
        await this.loadContactsBatch(Array.from(contactIdsToLoad));
      }

      // Проверяем следующую страницу
      const next = response.next;
      if (typeof next === 'number' && next > 0) {
        await this.delay(500);
        // Используем setImmediate для предотвращения блокировки event loop
        setImmediate(() => this.loadDeals(next, manual));
      } else {
        console.log('✅ Все страницы сделок обработаны');
      }

    } catch (error) {
      console.error('❌ Ошибка загрузки сделок:', error.message);
      throw error;
    } finally {
      // Очищаем таймаут
      clearTimeout(syncTimeout);
      
      // Сбрасываем состояние
      this.isSyncing = false;
      this.currentRecursionDepth--;
    }
  }

  // Утилиты
  chunkArray(array, size) {
    // Защита от некорректных параметров
    if (!Array.isArray(array) || size <= 0) {
      return [];
    }
    
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Запуск полной синхронизации
  async startupSync() {
    try {
      console.log('🚀 Запуск полной синхронизации...');
      
      // Проверяем соединение с БД
      const dbConnected = await this.db.testConnection();
      if (!dbConnected) {
        throw new Error('Database connection failed');
      }

      // Параллельная загрузка справочников
      await Promise.all([
        this.loadPipelines(),
        this.loadStages()
      ]);

      // Загрузка сделок с использованием setImmediate для предотвращения блокировки
      setImmediate(() => this.loadDeals(0, true));
      
      console.log('✅ Запуск синхронизации инициирован');
    } catch (error) {
      console.error('❌ Ошибка полной синхронизации:', error.message);
      throw error;
    }
  }

  // Закрытие сервиса
  async close() {
    await this.db.close();
  }
}

module.exports = SyncService;
