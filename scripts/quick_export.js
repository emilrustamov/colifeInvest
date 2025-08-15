const { Pool } = require('pg');
const fs = require('fs').promises;

// Простой экспорт структуры БД
async function quickExport() {
  const pool = new Pool({
    user: process.env.DB_USER || 'myuser',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'colife',
    password: process.env.DB_PASSWORD || 'mypassword',
    port: process.env.DB_PORT || 5432,
  });

  try {
    console.log('🔍 Подключение к БД...');
    const client = await pool.connect();

    // Получаем список таблиц
    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);

    let output = `# 📊 Структура базы данных ${process.env.DB_NAME || 'colife'}

## 🗂️ Список таблиц (${tables.rows.length})

`;

    for (const table of tables.rows) {
      const tableName = table.table_name;
      console.log(`📝 Обрабатываю: ${tableName}`);

      // Получаем структуру таблицы
      const columns = await client.query(`
        SELECT 
          column_name,
          data_type,
          is_nullable,
          column_default
        FROM information_schema.columns 
        WHERE table_name = $1 
        ORDER BY ordinal_position
      `, [tableName]);

      output += `## 📋 ${tableName}\n\n`;
      output += `| Поле | Тип | Null | По умолчанию |\n`;
      output += `|------|-----|------|---------------|\n`;

      for (const col of columns.rows) {
        const nullable = col.is_nullable === 'YES' ? '✅' : '❌';
        const defaultValue = col.column_default || '-';
        output += `| \`${col.column_name}\` | \`${col.data_type}\` | ${nullable} | \`${defaultValue}\` |\n`;
      }

      output += `\n---\n\n`;
    }

    // Сохраняем в файл
    await fs.writeFile('database-structure.md', output, 'utf8');
    console.log('✅ Структура БД сохранена в database-structure.md');

    client.release();
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  } finally {
    await pool.end();
  }
}

quickExport();
