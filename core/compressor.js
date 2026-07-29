/**
 * 压缩管线 - 多策略融合
 *
 * 5 轮 LLM 调用：
 * L1 删废话 → L2 类型化压缩 → L3 结构化(PList) → L4 原型锚点 → L5 一句话总结
 */

import { generateQuietPrompt } from '../../../../../script.js';
import { DELETE_FILLER_PROMPT, TYPE_SPECIFIC_PROMPT, PLIST_FORMAT_PROMPT, ARCHETYPE_PROMPT, SUMMARY_PROMPT } from './prompts.js';

/**
 * 执行多策略压缩管线
 * @param {string} originalText - 原始角色卡文本
 * @param {object} options - 压缩选项
 * @returns {Promise<string>} 压缩后的 PList 格式文本
 */
export async function compressPipeline(originalText, options = {}) {
    const {
        format = 'plist',
        tokenTarget = 150,
        archetypeAnchoring = true,
        schemaCompression = true,
        chineseTokenTaxOpt = 'off',
    } = options;

    console.log('TokenSlim: 开始压缩管线...');

    // L1 删废话（粗筛）
    const l1 = await llmCompress(originalText, DELETE_FILLER_PROMPT);
    console.log('TokenSlim: L1 删废话完成');

    // L2 类型化压缩（按文本类型路由）
    const textType = classifyText(originalText);
    const l2Prompt = TYPE_SPECIFIC_PROMPT[textType] || TYPE_SPECIFIC_PROMPT.default;
    const l2 = await llmCompress(l1, l2Prompt);
    console.log('TokenSlim: L2 类型化压缩完成');

    // L3 结构化（PList / 精简列表 / W++）
    const l3Prompt = getFormatPrompt(format, tokenTarget);
    const l3 = await llmCompress(l2, l3Prompt);
    console.log('TokenSlim: L3 结构化完成');

    // L4 原型锚点（识别原型 + 只保留偏离）
    let l4 = l3;
    if (archetypeAnchoring) {
        l4 = await llmCompress(l3, ARCHETYPE_PROMPT);
        console.log('TokenSlim: L4 原型锚点完成');
    }

    // L5 一句话总结
    const l5 = await llmCompress(l4, SUMMARY_PROMPT);
    console.log('TokenSlim: L5 一句话总结完成');

    // 中文 token 税规避（可选后处理）
    let result = l5;
    if (chineseTokenTaxOpt !== 'off') {
        result = applyChineseTokenTaxOpt(result, chineseTokenTaxOpt);
    }

    return result;
}

/**
 * 调用 LLM 执行压缩
 * @param {string} text - 待压缩文本
 * @param {string} prompt - LLM prompt
 * @returns {Promise<string>} 压缩结果
 */
async function llmCompress(text, prompt) {
    try {
        const fullPrompt = `${prompt}\n\n## 输入\n${text}\n\n## 输出\n直接输出结果，不要任何前缀或解释。`;
        const result = await generateQuietPrompt({ quietPrompt: fullPrompt });
        return (result || text).trim();
    } catch (err) {
        console.warn('TokenSlim: LLM 压缩失败，返回原文', err);
        return text;
    }
}

/**
 * 识别文本类型
 */
function classifyText(text) {
    const lower = text.toLowerCase();

    // 关键词权重判断
    const types = {
        personality: ['性格', '个性', 'personality', '温柔', '冷酷', '傲娇', '暴躁', '善良'],
        appearance: ['外貌', '外观', 'appearance', '银发', '长发', '身高', '体型', '瞳色'],
        backstory: ['背景', '过去', '历史', 'backstory', '曾经', '五年前', '小时候', '故乡'],
        relationship: ['关系', '朋友', '敌人', '闺蜜', '恋人', '师徒', '兄妹', 'relationship'],
        dialogue_style: ['说话', '语气', '口癖', 'speech', '口癖', '头口禅'],
    };

    let maxScore = 0;
    let maxType = 'default';

    for (const [type, keywords] of Object.entries(types)) {
        const score = keywords.filter(kw => lower.includes(kw)).length;
        if (score > maxScore) {
            maxScore = score;
            maxType = type;
        }
    }

    return maxType;
}

/**
 * 获取格式化 prompt
 */
function getFormatPrompt(format, tokenTarget) {
    const prompts = {
        plist: PLIST_FORMAT_PROMPT(tokenTarget),
        concise: `将以下内容转为精简列表格式。每行一个类别，格式：类别: 关键词1, 关键词2。总 token 目标 ≤ ${tokenTarget}。`,
        wplus: `将以下内容转为 W+ 简化格式。格式：Category(keyword + keyword)。总 token 目标 ≤ ${tokenTarget}。`,
        wplusplus: `将以下内容转为 W++ 格式。格式：[character("名"){Category("keyword" + "keyword")}]。总 token 目标 ≤ ${tokenTarget}。`,
    };
    return prompts[format] || prompts.plist;
}

/**
 * 中文 token 税规避后处理
 */
function applyChineseTokenTaxOpt(text, strategy) {
    if (strategy === 'off') return text;

    // 常见中文术语 → 英文映射
    const termMap = {
        '愤世嫉俗': 'cynical',
        '机器学习': 'ML',
        '深度学习': 'DL',
        '人工智能': 'AI',
        '自然语言': 'NLP',
        '创伤后应激': 'PTSD',
        '注意力缺陷': 'ADHD',
    };

    let result = text;
    for (const [cn, en] of Object.entries(termMap)) {
        if (strategy === 'english_terms') {
            result = result.replace(new RegExp(cn, 'g'), en);
        } else if (strategy === 'bilingual') {
            result = result.replace(new RegExp(cn, 'g'), `${cn}(${en})`);
        }
    }
    return result;
}
