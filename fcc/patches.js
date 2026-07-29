/**
 * FCC 增量补丁（append-only）
 *
 * 核心原则：永远不修改 FCC 冻结内容，只在末尾追加
 * 补丁不破坏前缀缓存，只延长尾部
 */

import { generateQuietPrompt } from '../../../../../script.js';
import { countTokens } from '../core/tokenizer.js';

/**
 * 追加补丁到 FCC
 * @param {object} fcc - FCC 数据（会被就地修改）
 * @param {object} patch - 补丁数据 { trigger_reason, content }
 */
export async function appendPatch(fcc, patch) {
    if (!fcc.patches) {
        fcc.patches = [];
    }

    const seq = fcc.patches.length + 1;
    const tokens = await countTokens(patch.content);

    fcc.patches.push({
        seq,
        timestamp: new Date().toISOString(),
        trigger_reason: patch.trigger_reason || 'user_manual',
        content: patch.content,
        tokens,
    });

    // 重新计算总 token
    fcc.content.token_count += tokens;

    console.log(`TokenSlim: 补丁 #${seq} 已追加（${tokens}tok）`);
}

/**
 * 折叠补丁（Summaryception 递归压缩）
 * 将多个补丁压缩回冻结主体
 * @param {object} fcc - FCC 数据
 */
export async function foldPatches(fcc) {
    if (!fcc.patches || fcc.patches.length === 0) {
        return;
    }

    try {
        // 将补丁内容合并
        const patchContents = fcc.patches.map(p => `[${p.seq}] ${p.content}`).join('\n');

        // 用 LLM 压缩补丁
        const foldPrompt = `将以下增量更新压缩为最精炼的摘要，保留所有关键变化（关系变化、数值变化、事件发生）。

增量更新：
${patchContents}

压缩结果：`;

        const foldedContent = await generateQuietPrompt({ quietPrompt: foldPrompt });

        // 追加到冻结主体
        fcc.content.raw += '\n\n=== 折叠更新 ===\n' + (foldedContent || patchContents).trim();

        // 重新计算 token
        fcc.content.token_count = await countTokens(fcc.content.raw);

        // 清空补丁
        fcc.patches = [];

        console.log('TokenSlim: 补丁已折叠回冻结主体');
    } catch (err) {
        console.error('TokenSlim: 补丁折叠失败', err);
        throw err;
    }
}
