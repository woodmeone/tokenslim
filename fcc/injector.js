/**
 * FCC 注入器
 *
 * 将 FCC 以 before_char 单一条目注入到 prompt
 * 注入配置：position=1(before_char), depth=0, scan=false, role=system
 */

import { setExtensionPrompt, characters, this_chid } from '../../../../../script.js';
import { getCacheStrategy } from '../core/cache-router.js';

const FCC_INJECT_KEY = 'tokenslim_fcc';  // setExtensionPrompt 唯一 key

/**
 * 注入 FCC 到 prompt
 * @param {object} fcc - FCC 数据
 * @param {string} key - setExtensionPrompt 的 key
 * @param {number} position - 注入位置（1=before_char）
 * @param {number} depth - 深度
 * @param {boolean} scan - 是否参与 WI 扫描
 * @param {number} role - 角色（extension_prompt_roles 枚举值）
 * @param {object} strategy - 缓存策略（可选，不传则自动获取）
 */
export function injectFCC(fcc, key, position, depth, scan, role, strategy) {
    try {
        const content = buildInjectionContent(fcc);

        // 根据缓存策略处理
        if (!strategy) {
            strategy = getCacheStrategy();
        }

        // 直接调用 import 的 setExtensionPrompt
        setExtensionPrompt(key, content, position, depth, scan, role);

        // 如果前缀过短，输出警告
        if (strategy.minPrefixTokens > 0) {
            const prefixTokens = fcc.content?.token_count || 0;
            if (prefixTokens < strategy.minPrefixTokens) {
                console.warn(`TokenSlim: FCC 内容仅 ${prefixTokens} tokens，未达 ${strategy.minPrefixTokens} 最小前缀，${strategy.provider} 可能无法命中缓存`);
            }
        }

        console.log('TokenSlim: FCC 已注入', { position, key, tokenCount: fcc.content?.token_count });
    } catch (err) {
        console.error('TokenSlim: FCC 注入失败', err);
    }
}

/**
 * 移除 FCC 注入
 * @param {string} key - setExtensionPrompt 的 key
 */
export function removeFCC(key) {
    try {
        setExtensionPrompt(key, '', 1, 0, false, 0);
        console.log('TokenSlim: FCC 注入已移除');
    } catch (err) {
        console.error('TokenSlim: FCC 移除失败', err);
    }
}

/**
 * 确保 FCC 已注入（兜底）
 * @param {string} key
 * @param {number} position
 * @param {number} depth
 * @param {boolean} scan
 * @param {number} role
 */
export function ensureFCCInjected(key, position, depth, scan, role) {
    try {
        const char = characters?.[this_chid];
        const fcc = char?.data?.extensions?.tokenslim?.fcc;

        if (fcc && fcc.content?.raw) {
            const strategy = getCacheStrategy();
            injectFCC(fcc, key, position, depth, scan, role, strategy);
        }
    } catch (err) {
        console.warn('TokenSlim: FCC 兜底注入失败', err);
    }
}

/**
 * 构建 FCC 注入内容（冻结部分 + 补丁部分）
 * @param {object} fcc - FCC 数据
 * @returns {string} 注入内容
 */
export function buildInjectionContent(fcc) {
    let content = fcc.content.raw;  // 冻结部分，永不变

    if (fcc.patches && fcc.patches.length > 0) {
        content += '\n\n=== 增量更新 ===\n';
        content += fcc.patches.map(p => `[${p.seq}] ${p.content}`).join('\n');
    }

    return content;
}
