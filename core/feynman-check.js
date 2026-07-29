/**
 * Feynman Technique 压缩质量自检
 *
 * 原理：「向小孩解释」暴露理解缺口
 * 压缩完成后自检：对比原文，检查是否有信息丢失
 */

import { generateQuietPrompt } from '../../../../../script.js';

/**
 * 执行 Feynman 自检
 * @param {string} compressedContent - 压缩后的内容
 * @param {string} originalText - 原始文本
 * @returns {Promise<object>} 自检结果 { gaps, quality_score }
 */
export async function feynmanSelfCheck(compressedContent, originalText) {
    try {
        // 对比原文，检查信息丢失（最关键）
        const gapsPrompt = `对比以下原文与压缩版，仅列出压缩版中遗漏的对角色演绎有影响的关键信息。
如果没有关键遗漏，回复"无关键遗漏"。

原文：${originalText.substring(0, 2000)}
压缩：${compressedContent}

遗漏的关键信息：`;

        const gaps = await generateQuietPrompt({ quietPrompt: gapsPrompt });

        // 计算质量分数（简单启发式）
        const qualityScore = calculateQualityScore(gaps);

        return {
            gaps: (gaps || '').trim(),
            quality_score: qualityScore,
        };
    } catch (err) {
        console.warn('TokenSlim: Feynman 自检失败', err);
        return {
            gaps: '自检失败',
            quality_score: -1,
        };
    }
}

/**
 * 计算压缩质量分数
 * @param {string} gaps - 遗漏信息
 * @returns {number} 0-100 分
 */
function calculateQualityScore(gaps) {
    if (!gaps) return 80;

    const trimmed = gaps.trim();

    // 无关键遗漏
    if (trimmed.includes('无关键遗漏') || trimmed.includes('没有遗漏') || trimmed.includes('no key')) {
        return 95;
    }

    // 根据遗漏条目数打分
    const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
    const gapCount = Math.max(lines.length, 1);

    if (gapCount <= 1) return 80;
    if (gapCount <= 3) return 65;
    if (gapCount <= 5) return 50;
    return 30;
}
