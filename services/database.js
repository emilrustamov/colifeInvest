const { Pool } = require('pg');
const { config } = require('../config');

class DatabaseService {
  constructor() {
    this.pool = new Pool(config.database);
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.pool.on('error', (err) => {
      console.error('❌ Unexpected error on idle client', err);
      // Не завершаем процесс сразу, только логируем
      console.warn('⚠️ Database pool error, but continuing...');
    });

    this.pool.on('connect', () => {
      console.log('🔌 New database connection established');
    });

    this.pool.on('remove', () => {
      console.log('🔌 Database connection removed from pool');
    });
  }

  // Проверка соединения с базой данных
  async testConnection() {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      console.log('✅ Database connection successful');
      return true;
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      return false;
    }
  }

  // Batch операции для оптимизации
  async batchInsert(table, columns, values, conflictColumns = null) {
    if (values.length === 0) return [];
    
    // Валидация входных данных для предотвращения SQL injection
    const validTableName = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table);
    const validColumns = columns.every(col => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col));
    
    if (!validTableName || !validColumns) {
      throw new Error('Invalid table or column names');
    }
    
    const placeholders = values.map((_, rowIndex) => {
      const rowPlaceholders = columns.map((_, colIndex) => 
        `$${rowIndex * columns.length + colIndex + 1}`
      );
      return `(${rowPlaceholders.join(', ')})`;
    }).join(', ');

    let query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`;
    
    if (conflictColumns) {
      const validConflictColumns = conflictColumns.every(col => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col));
      if (!validConflictColumns) {
        throw new Error('Invalid conflict column names');
      }
      
      const updateColumns = columns.filter(col => !conflictColumns.includes(col));
      if (updateColumns.length > 0) {
        query += ` ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET `;
        query += updateColumns.map(col => `${col} = EXCLUDED.${col}`).join(', ');
      }
    }

    try {
      const flattenedValues = values.flat();
      const result = await this.pool.query(query, flattenedValues);
      return result;
    } catch (error) {
      console.error(`❌ Batch insert error for table ${table}:`, error.message);
      throw new Error(`Batch insert failed: ${error.message}`);
    }
  }

  // Оптимизированная вставка/обновление сделок
  async upsertDeals(deals) {
    if (deals.length === 0) return;
    
    const columns = ['deal_id', 'title', 'current_stage_id', 'pipeline_id', 'contact_id', 'link'];
    const values = deals.map(deal => [
      deal.ID,
      deal.TITLE,
      deal.STAGE_ID,
      deal.CATEGORY_ID,
      deal.CONTACT_ID,
      deal.link
    ]);

    await this.batchInsert('deals', columns, values, ['deal_id']);
  }

  // Оптимизированная вставка/обновление контактов
  async upsertContacts(contacts) {
    if (contacts.length === 0) return;
    
    const columns = ['id', 'contact_name', 'phone', 'link'];
    const values = contacts.map(contact => [
      contact.ID,
      contact.NAME || '',
      contact.phone || null,
      contact.link
    ]);

    await this.batchInsert('contacts', columns, values, ['id']);
  }

  // Оптимизированная вставка связей сделка-контакт
  async upsertDealContacts(dealId, relations) {
    if (relations.length === 0) return;
    
    // Сначала удаляем старые связи
    await this.pool.query(
      'DELETE FROM deal_contacts WHERE deal_id = $1',
      [dealId]
    );

    const columns = ['deal_id', 'contact_id', 'is_primary', 'sort_index', 'role_id'];
    const values = relations.map(rel => [
      dealId,
      Number(rel.CONTACT_ID),
      rel.IS_PRIMARY === 'Y' || rel.IS_PRIMARY === true,
      rel.SORT ? parseInt(rel.SORT, 10) : null,
      rel.ROLE_ID ? parseInt(rel.ROLE_ID, 10) : null
    ]);

    await this.batchInsert('deal_contacts', columns, values);
  }

  // Получение данных с пагинацией и фильтрацией
  async getDealsWithFilters(filters, page = 1, limit = 100) {
    const offset = (page - 1) * limit;
    const params = [];
    const whereConditions = [];

    // Построение WHERE условий
    if (filters.pipelineId) {
      params.push(filters.pipelineId);
      whereConditions.push(`d.pipeline_id = $${params.length}`);
    }
    
    if (filters.stageId) {
      params.push(filters.stageId);
      whereConditions.push(`d.current_stage_id = $${params.length}`);
    }
    
    if (filters.search) {
      params.push(`%${filters.search}%`);
      params.push(`%${filters.search}%`);
      whereConditions.push(`(d.title ILIKE $${params.length - 1} OR c.contact_name ILIKE $${params.length})`);
    }

    // Подсчет общего количества
    let countQuery = `
      SELECT COUNT(*) AS total
      FROM deals d
      LEFT JOIN contacts c ON d.contact_id = c.id
    `;
    
    if (whereConditions.length > 0) {
      countQuery += ` WHERE ${whereConditions.join(' AND ')}`;
    }

    const countResult = await this.pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Получение данных
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

    if (whereConditions.length > 0) {
      dataQuery += ` WHERE ${whereConditions.join(' AND ')}`;
    }

    params.push(limit, offset);
    dataQuery += `
      ORDER BY d.pipeline_id DESC, s.stage_name DESC, d.deal_id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const dataResult = await this.pool.query(dataQuery, params);

    return {
      data: dataResult.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  // Получение всех ID контактов
  async getAllContactIds() {
    const result = await this.pool.query("SELECT id FROM contacts");
    return result.rows.map(r => r.id);
  }

  // Получение всех контактов с информацией о сделках
  async getAllContacts() {
    const result = await this.pool.query(`
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
    return result.rows;
  }

  // Удаление контакта с проверкой связей
  async deleteContact(contactId) {
    try {
      // Проверяем, есть ли связанные сделки
      const res = await this.pool.query(
        "SELECT 1 FROM deal_contacts WHERE contact_id = $1 LIMIT 1",
        [contactId]
      );
      
      if (res.rows.length > 0) {
        return {
          success: false,
          message: "Есть связанные сделки. Нельзя удалить."
        };
      }
      
      // Удаляем контакт
      await this.pool.query("DELETE FROM contacts WHERE id = $1", [contactId]);
      return { success: true, contactId };
    } catch (error) {
      throw new Error(`Ошибка удаления контакта: ${error.message}`);
    }
  }

  // Получение ID воронок (кроме основной)
  async getPipelineIds() {
    const result = await this.pool.query('SELECT id FROM pipelines WHERE id != 0');
    return result.rows;
  }

  // Получение всех ID стадий
  async getAllStageIds() {
    const result = await this.pool.query('SELECT stage_id FROM stages');
    return result.rows;
  }

  // Удаление воронок по ID
  async deletePipelines(pipelineIds) {
    if (pipelineIds.length === 0) return;
    
    try {
      // Сначала удаляем связанные стадии
      await this.pool.query(
        'DELETE FROM stages WHERE pipeline_id = ANY($1)',
        [pipelineIds]
      );
      
      // Затем удаляем воронки
      await this.pool.query(
        'DELETE FROM pipelines WHERE id = ANY($1)',
        [pipelineIds]
      );
      
      console.log(`🗑️ Удалено ${pipelineIds.length} воронок и связанных стадий`);
    } catch (error) {
      throw new Error(`Ошибка удаления воронок: ${error.message}`);
    }
  }

  // Удаление стадий по ID
  async deleteStages(stageIds) {
    if (stageIds.length === 0) return;
    
    try {
      await this.pool.query(
        'DELETE FROM stages WHERE stage_id = ANY($1)',
        [stageIds]
      );
      
      console.log(`🗑️ Удалено ${stageIds.length} стадий`);
    } catch (error) {
      throw new Error(`Ошибка удаления стадий: ${error.message}`);
    }
  }

  // Получение фильтров (воронки и стадии)
  async getFilters() {
    const pipelines = await this.pool.query(
      "SELECT id, name FROM pipelines ORDER BY name ASC"
    );

    const stages = await this.pool.query(
      "SELECT stage_id, stage_name, pipeline_id FROM stages ORDER BY pipeline_id ASC, stage_name ASC"
    );

    return {
      pipelines: pipelines.rows,
      stages: stages.rows,
    };
  }

  // Закрытие соединений
  async close() {
    await this.pool.end();
    console.log('🔌 Database connections closed');
  }
}

module.exports = DatabaseService;
