const axios = require('axios');
const { config } = require('../config');

class Bitrix24API {
  constructor() {
    this.webhookBase = config.bitrix24.webhookBase;
    this.domain = config.bitrix24.domain;
    this.requestQueue = [];
    this.isProcessing = false;
    this.lastRequestTime = 0;
    this.minDelay = 100; // минимальная задержка между запросами (мс)
  }

  // Создание URL для контактов и сделок
  createEntityUrl(entityType, entityId) {
    return `https://${this.domain}/crm/${entityType}/details/${entityId}/`;
  }

  // Rate limiting для API запросов
  async throttleRequest() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minDelay) {
      await new Promise(resolve => 
        setTimeout(resolve, this.minDelay - timeSinceLastRequest)
      );
    }
    
    this.lastRequestTime = Date.now();
  }

  // Базовый метод для API запросов
  async makeRequest(method, endpoint, data = null, params = null) {
    await this.throttleRequest();
    
    try {
      const config = {
        method,
        url: `${this.webhookBase}${endpoint}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      };

      if (data) {
        config.data = new URLSearchParams(data);
      }
      
      if (params) {
        config.params = params;
      }

      const response = await axios(config);
      
      if (response.data && response.data.error) {
        throw new Error(`Bitrix24 API Error: ${response.data.error_description || response.data.error}`);
      }
      
      return response.data;
    } catch (error) {
      if (error.response?.status === 503) {
        console.warn('⏳ Bitrix24 API временно недоступен (503), повторная попытка через 2 сек...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        return this.makeRequest(method, endpoint, data, params);
      }
      
      throw new Error(`Bitrix24 API request failed: ${error.message}`);
    }
  }

  // Получение воронок
  async getPipelines() {
    return this.makeRequest('POST', 'crm.category.list', { entityTypeId: 2 });
  }

  // Получение стадий
  async getStages(entityId) {
    return this.makeRequest('GET', 'crm.status.list', null, { 
      filter: { ENTITY_ID: entityId } 
    });
  }

  // Получение сделок
  async getDeals(start = 0, select = ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'CONTACT_ID']) {
    return this.makeRequest('GET', 'crm.deal.list', null, {
      select,
      order: { ID: 'ASC' },
      start
    });
  }

  // Получение контактов
  async getContacts(contactIds, select = ['ID', 'NAME', 'PHONE']) {
    return this.makeRequest('GET', 'crm.contact.list', null, {
      select,
      filter: { '@ID': contactIds }
    });
  }

  // Получение связей сделка-контакт
  async getDealContacts(dealId) {
    const params = new URLSearchParams();
    params.append('id', dealId);
    return this.makeRequest('POST', 'crm.deal.contact.items.get', params);
  }

  // Обновление контакта
  async updateContact(contactId, fields) {
    return this.makeRequest('POST', 'crm.contact.update', {
      id: contactId,
      fields: JSON.stringify(fields)
    });
  }

  // Batch операции для оптимизации
  async batchRequest(requests) {
    const batchData = {
      cmd: requests.map((req, index) => 
        `${index}:${req.method}/${req.endpoint}`
      ).join(';'),
      ...requests.reduce((acc, req, index) => {
        acc[index] = req.data ? JSON.stringify(req.data) : '';
        return acc;
      }, {})
    };

    return this.makeRequest('POST', 'batch', batchData);
  }
}

module.exports = Bitrix24API;
