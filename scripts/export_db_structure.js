const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

// Конфигурация БД (используем переменные окружения)
const pool = new Pool({
  user: process.env.DB_USER || 'myuser',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'colife',
  password: process.env.DB_PASSWORD || 'mypassword',
  port: process.env.DB_PORT || 5432,
});

async function exportDatabaseStructure() {
  try {
    console.log('🔍 Подключение к базе данных...');
    const client = await pool.connect();
    
    // Получаем список всех таблиц
    const tablesQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `;
    
    const tablesResult = await client.query(tablesQuery);
    const tables = tablesResult.rows.map(row => row.table_name);
    
    console.log(`📋 Найдено таблиц: ${tables.length}`);
    
    let markdown = `# 📊 Структура базы данных

## 🗂️ Обзор таблиц

Всего таблиц: **${tables.length}**

`;

    // Для каждой таблицы получаем структуру
    for (const tableName of tables) {
      console.log(`📝 Обрабатываю таблицу: ${tableName}`);
      
      // Получаем структуру таблицы
      const columnsQuery = `
        SELECT 
          column_name,
          data_type,
          is_nullable,
          column_default,
          character_maximum_length,
          numeric_precision,
          numeric_scale
        FROM information_schema.columns 
        WHERE table_name = $1 
        ORDER BY ordinal_position
      `;
      
      const columnsResult = await client.query(columnsQuery, [tableName]);
      const columns = columnsResult.rows;
      
      // Получаем индексы
      const indexesQuery = `
        SELECT 
          indexname,
          indexdef
        FROM pg_indexes 
        WHERE tablename = $1
      `;
      
      const indexesResult = await client.query(indexesQuery, [tableName]);
      const indexes = indexesResult.rows;
      
      // Получаем внешние ключи
      const foreignKeysQuery = `
        SELECT 
          tc.constraint_name,
          tc.table_name,
          kcu.column_name,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' 
          AND tc.table_name = $1
      `;
      
      const foreignKeysResult = await client.query(foreignKeysQuery, [tableName]);
      const foreignKeys = foreignKeysResult.rows;
      
      // Формируем Markdown для таблицы
      markdown += `## 📋 Таблица: \`${tableName}\`

### 🏗️ Структура полей

| Поле | Тип | Null | По умолчанию | Описание |
|------|-----|------|---------------|----------|
`;
      
      for (const column of columns) {
        let dataType = column.data_type;
        
        if (column.character_maximum_length) {
          dataType += `(${column.character_maximum_length})`;
        }
        
        if (column.numeric_precision && column.numeric_scale) {
          dataType += `(${column.numeric_precision},${column.numeric_scale})`;
        } else if (column.numeric_precision) {
          dataType += `(${column.numeric_precision})`;
        }
        
        const nullable = column.is_nullable === 'YES' ? '✅' : '❌';
        const defaultValue = column.column_default || '-';
        
        markdown += `| \`${column.column_name}\` | \`${dataType}\` | ${nullable} | \`${defaultValue}\` | - |\n`;
      }
      
      markdown += `\n`;
      
      // Добавляем индексы
      if (indexes.length > 0) {
        markdown += `### 🔍 Индексы\n\n`;
        for (const index of indexes) {
          markdown += `- **${index.indexname}**: \`${index.indexdef}\`\n`;
        }
        markdown += `\n`;
      }
      
      // Добавляем внешние ключи
      if (foreignKeys.length > 0) {
        markdown += `### 🔗 Внешние ключи\n\n`;
        for (const fk of foreignKeys) {
          markdown += `- **${fk.constraint_name}**: \`${fk.column_name}\` → \`${fk.foreign_table_name}.${fk.foreign_column_name}\`\n`;
        }
        markdown += `\n`;
      }
      
      markdown += `---\n\n`;
    }
    
    // Добавляем общую информацию о БД
    const dbInfoQuery = `
      SELECT 
        current_database() as database_name,
        current_user as current_user,
        version() as postgres_version
    `;
    
    const dbInfoResult = await client.query(dbInfoQuery);
    const dbInfo = dbInfoResult.rows[0];
    
    markdown = `# 📊 Структура базы данных

## ℹ️ Информация о БД

- **База данных**: \`${dbInfo.database_name}\`
- **Пользователь**: \`${dbInfo.current_user}\`
- **Версия PostgreSQL**: \`${dbInfo.postgres_version}\`
- **Дата экспорта**: ${new Date().toLocaleString('ru-RU')}

## 🗂️ Обзор таблиц

Всего таблиц: **${tables.length}**

` + markdown;
    
    // Сохраняем в файл
    const outputPath = path.join(__dirname, '..', 'docs', 'database-structure.md');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, markdown, 'utf8');
    
    console.log(`✅ Структура БД экспортирована в: ${outputPath}`);
    
    // Также создаем SQL файл для создания таблиц
    const createTablesQuery = `
      SELECT 
        'CREATE TABLE ' || quote_ident(tablename) || ' (' ||
        string_agg(
          quote_ident(columnname) || ' ' || 
          format_type(atttypid, atttypmod) ||
          CASE 
            WHEN attnotnull THEN ' NOT NULL'
            ELSE ''
          END ||
          CASE 
            WHEN atthasdef THEN ' DEFAULT ' || pg_get_expr(adbin, adrelid)
            ELSE ''
          END,
          ', '
          ORDER BY attnum
        ) || ');' as create_statement
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE n.nspname = 'public' 
        AND c.relkind = 'r'
        AND a.attnum > 0 
        AND NOT a.attisdropped
      GROUP BY tablename
      ORDER BY tablename
    `;
    
    const createTablesResult = await client.query(createTablesQuery);
    let sqlOutput = `-- SQL скрипт для создания таблиц
-- База данных: ${dbInfo.database_name}
-- Дата: ${new Date().toLocaleString('ru-RU')}

`;
    
    for (const row of createTablesResult.rows) {
      sqlOutput += row.create_statement + '\n\n';
    }
    
    const sqlOutputPath = path.join(__dirname, '..', 'docs', 'create-tables.sql');
    await fs.writeFile(sqlOutputPath, sqlOutput, 'utf8');
    
    console.log(`✅ SQL скрипт сохранен в: ${sqlOutputPath}`);
    
    client.release();
    
  } catch (error) {
    console.error('❌ Ошибка экспорта структуры БД:', error.message);
  } finally {
    await pool.end();
  }
}

// Запускаем экспорт
exportDatabaseStructure();
