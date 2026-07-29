/**
 * 三厂商缓存策略路由器
 *
 * Anthropic: 需要显式 cache_control 断点，90% off
 * OpenAI: 自动前缀匹配，50%-90% off
 * DeepSeek: 稳定即可命中，90% off
 */

import { main_api } from '../../../../../script.js';

/**
 * 获取当前 API 的缓存策略
 * @returns {object} 缓存策略
 */
export function getCacheStrategy() {
    const strategies = {
        anthropic: {
            provider: 'anthropic',
            minPrefixTokens: 1024,
            supportsCacheControl: true,
            ttl: 300,
            discount: 0.1,
        },
        openai: {
            provider: 'openai',
            minPrefixTokens: 1024,
            supportsCacheControl: false,
            ttl: 600,
            discount: 0.5,
        },
        openaichat: {
            provider: 'openai',
            minPrefixTokens: 1024,
            supportsCacheControl: false,
            ttl: 600,
            discount: 0.5,
        },
        openaiendpoint: {
            provider: 'openai-compatible',
            minPrefixTokens: 1024,
            supportsCacheControl: false,
            ttl: 600,
            discount: 0.5,
        },
        deepseek: {
            provider: 'deepseek',
            minPrefixTokens: 0,
            supportsCacheControl: false,
            ttl: 0,
            discount: 0.1,
        },
        custom: {
            provider: 'custom',
            minPrefixTokens: 1024,
            supportsCacheControl: false,
            ttl: 0,
            discount: 0,
        },
    };

    const apiType = typeof main_api !== 'undefined' ? main_api : 'unknown';

    return strategies[apiType] || {
        provider: apiType || 'unknown',
        minPrefixTokens: 1024,
        supportsCacheControl: false,
        ttl: 0,
        discount: 0,
    };
}

/**
 * 判断当前 API 是否需要显式 cache_control
 * @returns {boolean}
 */
export function needsCacheControl() {
    return getCacheStrategy().supportsCacheControl;
}
