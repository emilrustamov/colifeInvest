# Colife Invest - Монитор сделок

Веб-приложение для мониторинга сделок и контактов с интеграцией Bitrix24.

## 🚀 Быстрый старт

### Установка зависимостей
```bash
npm install
```

### Разработка
```bash
# Запуск сервера в режиме разработки
npm run dev

# Сборка CSS в режиме watch (в отдельном терминале)
npm run build:css
```

### Продакшн
```bash
# Сборка CSS для продакшна
npm run build:css:prod

# Запуск сервера
npm start
```

## 🎨 Стилизация

Проект использует **Tailwind CSS** для стилизации с кастомными компонентами в стиле **bento**.

### Структура CSS
- `src/input.css` - исходный файл с Tailwind директивами
- `public/styles.css` - скомпилированный CSS (генерируется автоматически)
- `tailwind.config.js` - конфигурация Tailwind
- `postcss.config.js` - конфигурация PostCSS

### Кастомные классы

#### Кнопки
```html
<button class="btn btn-primary">Основная кнопка</button>
<button class="btn btn-secondary">Вторичная кнопка</button>
<button class="btn btn-success">Успех</button>
<button class="btn btn-danger">Опасность</button>
<button class="btn btn-purple">Фиолетовая</button>
```

#### Карточки
```html
<div class="card card-hover">
  <div class="card-header">
    <h3 class="card-title">Заголовок карточки</h3>
  </div>
  <div class="p-6">
    Содержимое карточки
  </div>
</div>
```

#### Формы
```html
<div class="form-group">
  <label class="form-label">Название поля</label>
  <input type="text" class="form-input" placeholder="Введите текст">
</div>

<select class="form-select">
  <option>Выберите опцию</option>
</select>
```

#### Таблицы
```html
<div class="table-container">
  <div class="card-header">
    <h3 class="card-title">Заголовок таблицы</h3>
  </div>
  <table class="w-full">
    <thead class="table-header">
      <tr>
        <th>Заголовок</th>
      </tr>
    </thead>
    <tbody class="table-body">
      <tr class="table-row">
        <td class="table-cell">Ячейка</td>
      </tr>
    </tbody>
  </table>
</div>
```

#### Бейджи
```html
<span class="badge badge-success">Успех</span>
<span class="badge badge-warning">Предупреждение</span>
<span class="badge badge-info">Информация</span>
<span class="badge badge-purple">Фиолетовый</span>
```

#### Уведомления
```html
<div class="notification notification-success">Успешное уведомление</div>
<div class="notification notification-error">Ошибка</div>
<div class="notification notification-warning">Предупреждение</div>
<div class="notification notification-info">Информация</div>
```

### Цветовая палитра

Проект использует расширенную цветовую палитру:

- **Primary (Синий)**: `blue-50` до `blue-900`
- **Secondary (Серый)**: `slate-50` до `slate-900`
- **Success (Зеленый)**: `green-50` до `green-900`
- **Danger (Красный)**: `red-50` до `red-900`
- **Warning (Оранжевый)**: `orange-50` до `orange-900`
- **Purple (Фиолетовый)**: `purple-50` до `purple-900`

### Анимации

Доступные анимации:
- `.animate-fade-in` - плавное появление
- `.animate-slide-in-right` - появление справа
- `.animate-slide-out-right` - исчезновение вправо

## 📱 Адаптивность

Все компоненты адаптивны и оптимизированы для мобильных устройств.

## 🌙 Темная тема

Поддержка автоматического переключения на темную тему (если включена в системе).

## 🔧 Разработка

### Добавление новых стилей

1. Добавьте стили в `src/input.css` в соответствующий `@layer`
2. Tailwind автоматически пересоберет CSS

### Кастомизация цветов

Измените цвета в `tailwind.config.js` в секции `theme.extend.colors`

### Добавление новых компонентов

Создайте новые классы в `src/input.css` в секции `@layer components`

## 📁 Структура проекта

```
colifeInvest/
├── public/
│   ├── index.html          # Главная страница
│   ├── contacts.html       # Страница контактов
│   └── styles.css          # Скомпилированные стили
├── src/
│   └── input.css           # Исходные стили Tailwind
├── config/                  # Конфигурация приложения
├── services/               # Бизнес-логика
├── utils/                  # Утилиты
├── tailwind.config.js      # Конфигурация Tailwind
├── postcss.config.js       # Конфигурация PostCSS
└── package.json            # Зависимости и скрипты
```

## 🚀 Деплой

1. Соберите CSS для продакшна: `npm run build:css:prod`
2. Запустите сервер: `npm start`

## 📄 Лицензия

ISC
