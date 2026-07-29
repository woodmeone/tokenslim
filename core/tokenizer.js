/**
 * Token 计数封装
 * 使用 SillyTavern 内置的 getTokenCountAsync（从 tokenizers.js 导出）
 */

import { getTokenCountAsync } from '../../../../tokenizers.js';

/**
 * 计算文本的 token 数
 * @param {string} text - 待计数的文本
 * @param {number} padding - 填充（默认 0）
 * @returns {Promise<number>} token 数
 */
export async function countTokens(text, padding = 0) {
    try {
        return await getTokenCountAsync(text, padding);
    } catch (err) {
        console.warn('TokenSlim: Token 计数失败，使用估算', err);
        // 粗略估算：中文约 2 字/token，英文约 4 字/token
        const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const otherChars = text.length - chineseChars;
        return Math.ceil(chineseChars / 2 + otherChars / 4) + padding;
    }
}
