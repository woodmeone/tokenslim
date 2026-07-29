/**
 * 缓存杀手检测
 *
 * 5 条缓存杀手规则（只读检测，绝不自动修改）
 * 遵循决策（§5.2）：绝不主动修改用户世界书条目的 position/depth/role
 */

import { characters, this_chid } from '../../../../../script.js';
import { power_user } from '../../../../power-user.js';

/**
 * 执行缓存友好度检测
 * @returns {object} { score, issues[] }
 */
export function detectCacheKillers() {
    const issues = [];

    try {
        // 规则 1：系统提示含时间戳变量
        checkTimestampInSystem(issues);

        // 规则 2：FCC 前缀长度不足
        checkPrefixLength(issues);

        // 规则 3：配置中途修改检测（简化版）
        checkConfigStability(issues);

        // 规则 4：绿灯条目在 before/after_char（只读提示，不修改！）
        checkGreenLightEntries(issues);

        // 规则 5：Dn 深度注入检测
        checkDepthInjection(issues);

    } catch (err) {
        console.warn('TokenSlim: 缓存检测失败', err);
        issues.push({
            severity: 'medium',
            description: '缓存检测执行异常',
            fix: '请检查 SillyTavern 连接状态',
        });
    }

    // 计算总分
    const score = calculateCacheScore(issues);

    return { score, issues };
}

/**
 * 规则 1：系统提示含时间戳
 */
function checkTimestampInSystem(issues) {
    try {
        // 从 power_user.sysprompt 获取系统提示内容
        const sysPrompt = power_user?.sysprompt?.content || '';
        const timePatterns = /current_time|当前时间|今天是|current date|today is|\{\{time\}\}|\{\{date\}\}/i;
        if (timePatterns.test(sysPrompt)) {
            issues.push({
                severity: 'critical',
                description: '系统提示含时间戳变量（每轮变化 → 缓存全部失效）',
                fix: '时间戳放最后或干脆别放',
            });
        }
    } catch (e) { /* 忽略 */ }
}

/**
 * 规则 2：FCC 前缀长度不足
 */
function checkPrefixLength(issues) {
    try {
        const char = characters?.[this_chid];
        const fcc = char?.data?.extensions?.tokenslim?.fcc;

        if (fcc && fcc.content?.token_count) {
            if (fcc.content.token_count < 1024) {
                issues.push({
                    severity: 'medium',
                    description: `FCC 内容仅 ${fcc.content.token_count} tokens（OpenAI/Anthropic 需 ≥ 1024 才能命中缓存）`,
                    fix: '增加系统提示长度或 FCC 内容以达到最小前缀',
                });
            }
        }
    } catch (e) { /* 忽略 */ }
}

/**
 * 规则 3：配置稳定性（简化版）
 */
function checkConfigStability(issues) {
    // 无法在客户端检测服务端配置变化，简化为提示
    // 后续可通过追踪配置变化来实现
}

/**
 * 规则 4：绿灯条目在 before/after_char（只读提示！）
 */
function checkGreenLightEntries(issues) {
    try {
        const char = characters?.[this_chid];
        const book = char?.data?.character_book?.entries;

        if (!book) return;

        // before_char = position 1, after_char = position 2
        const greenAtBeforeAfter = Object.values(book).filter(entry =>
            entry.enabled &&
            !entry.constant &&  // 非蓝灯（非常驻）
            (entry.position === 1 || entry.position === 2)
        );

        if (greenAtBeforeAfter.length > 0) {
            issues.push({
                severity: 'medium',
                description: `${greenAtBeforeAfter.length} 个绿灯条目在 before/after_char 位置（激活变化可能影响缓存）`,
                fix: '由作者决定位置，TokenSlim 不会自动修改（§5.2 决策）',
            });
        }
    } catch (e) { /* 忽略 */ }
}

/**
 * 规则 5：Dn 深度注入检测
 */
function checkDepthInjection(issues) {
    try {
        const char = characters?.[this_chid];
        const book = char?.data?.character_book?.entries;

        if (!book) return;

        // 检查 Dn 注入（0 < depth < 9999 且 position = 4 即 at_depth）
        const depthEntries = Object.values(book).filter(entry =>
            entry.enabled &&
            entry.position === 4 &&  // at_depth
            entry.depth > 0 &&
            entry.depth < 9999
        );

        if (depthEntries.length > 0) {
            issues.push({
                severity: 'high',
                description: `${depthEntries.length} 个条目使用 D${depthEntries[0].depth} 深度注入（会让最近 N 层缓存失效）`,
                fix: '考虑将关键条目移到 D0 或 D9999',
            });
        }
    } catch (e) { /* 忽略 */ }
}

/**
 * 计算缓存健康度分数
 */
function calculateCacheScore(issues) {
    let score = 100;

    for (const issue of issues) {
        switch (issue.severity) {
            case 'critical': score -= 30; break;
            case 'high': score -= 15; break;
            case 'medium': score -= 5; break;
        }
    }

    return Math.max(0, Math.min(100, score));
}
