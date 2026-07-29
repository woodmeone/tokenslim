/**
 * TokenSlim - 角色卡省Token插件
 * 核心思路：角色卡+世界书不压缩（保持原样），只压缩聊天记录
 * 压缩时用角色卡+世界书作为参考上下文，让AI知道什么重要
 */

import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

// ==================== 常量 ====================
const EXT_KEY = 'tokenslim_fcc';
const EXT_NAME = 'tokenslim';
const EXT_FOLDER = `scripts/extensions/third-party/${EXT_NAME}`;
const FCC_POSITION = 1;  // before_char
const FCC_DEPTH = 0;
const FCC_SCAN = false;

// ==================== 默认设置 ====================
const defaultSettings = {
    enabled: true,
    format: 'timeline',       // 压缩格式
    tokenTarget: 300,         // 目标 token 数
    feynmanCheck: true,       // 质量自检
    autoInject: true,         // 自动注入
    autoLoadFCC: true,        // 打开角色时自动加载已有FCC
};

// ==================== 扩展状态 ====================
let currentFCC = null;

// ==================== 压缩格式定义 ====================
const FORMAT_OPTIONS = {
    timeline: {
        name: '时间线',
        desc: '按时间顺序压缩关键事件节点',
        example: 'T1: 初遇(公园,闲聊) → T2: 透露秘密(咖啡馆) → T3: 关系转折(雨夜,情感爆发)',
    },
    relationship: {
        name: '关系图谱',
        desc: '提取角色间关系变化轨迹',
        example: '(用户,艾莉丝): 陌生人→相识→信任→亲密 | 关键转折: 咖啡馆透露身世',
    },
    events: {
        name: '关键事件',
        desc: '只保留改变故事走向的转折点',
        example: '①初遇公园 ②咖啡馆深入对话 ③雨夜信任危机 ④和解后关系深化',
    },
    scenes: {
        name: '场景摘要',
        desc: '按场景分段压缩，保留场景内核心互动',
        example: '[公园] 初遇,天气,闲聊 | [咖啡馆] 深入对话,透露身世 | [雨夜] 情感冲突,和解',
    },
    plist: {
        name: 'PList',
        desc: '结构化属性列表，适合角色属性密集的对话',
        example: '[- 关系: 朋友→恋人; - 事件: 初遇→秘密→信任→亲密; - 情感: 疑虑→好奇→关心→深情;]',
    },
    freeform: {
        name: '自由摘要',
        desc: 'AI自由决定最佳压缩方式，最灵活',
        example: '用户与艾莉丝初遇于公园。几次深入交谈后，艾莉丝透露了自己的失忆秘密。经历雨夜的情感冲突后，两人关系从朋友升华为恋人。',
    },
};

// ==================== 初始化 ====================
jQuery(async () => {
    console.log('TokenSlim: 初始化...');

    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...defaultSettings };
    }
    const settings = extension_settings[EXT_NAME];

    // 确保 charData 子对象存在
    if (!settings.charData) settings.charData = {};

    const settingsHtml = await $.get(`${EXT_FOLDER}/settings.html`);
    $('#extensions_settings').append(settingsHtml);

    bindUIEvents(settings);

    // 监听聊天切换事件，自动加载该角色的 FCC
    const ctx = SillyTavern.getContext();
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        if (settings.autoLoadFCC) {
            currentFCC = loadFCC();
            if (currentFCC && settings.enabled && settings.autoInject) {
                injectFCC(currentFCC);
            }
            updateUIState(settings);
        }
    });

    // 监听生成前兜底注入
    ctx.eventSource.on(ctx.eventTypes.GENERATION_AFTER_COMMANDS, () => {
        if (settings.enabled && settings.autoInject) {
            ensureFCCInjected();
        }
    });

    // 初始加载
    currentFCC = loadFCC();
    if (currentFCC && settings.enabled && settings.autoInject) {
        injectFCC(currentFCC);
    }
    updateUIState(settings);

    console.log('TokenSlim: 初始化完成');
});

// ==================== 获取当前角色标识 ====================
function getCharacterKey() {
    const ctx = SillyTavern.getContext();
    const charData = getCurrentCharacterData();
    if (!charData) return null;
    // 用 avatar 文件名作为唯一标识
    return charData.char?.avatar || null;
}

// ==================== 获取当前角色卡数据 ====================
function getCurrentCharacterData() {
    const ctx = SillyTavern.getContext();
    const charId = ctx.characterId;

    if (charId !== undefined && charId !== null) {
        const char = ctx.characters[charId];
        if (char?.data) return { charId, char };
    }

    if (ctx.chat?.length > 0) {
        for (let i = 0; i < ctx.characters.length; i++) {
            const c = ctx.characters[i];
            if (c?.data && c.chat === ctx.chatId) return { charId: i, char: c };
        }
    }

    return null;
}

// ==================== 检测 AI API ====================
function checkAIAvailable() {
    const ctx = SillyTavern.getContext();
    const api = ctx.mainApi;
    if (!api || api === 'undefined') {
        return { available: false, reason: '请先在 SillyTavern 的 API 设置中配置 AI 连接（如 Claude、OpenAI 等），TokenSlim 会复用该连接进行压缩。' };
    }
    return { available: true, api };
}

// ==================== 收集文本 ====================
// 参考上下文：角色卡 + 世界书（不压缩，给AI理解用）
function getReferenceContext(charData) {
    const data = charData.char.data || {};
    const parts = [];

    if (data.description?.trim()) parts.push(`【角色描述】\n${data.description.trim()}`);
    if (data.personality?.trim()) parts.push(`【性格】\n${data.personality.trim()}`);
    if (data.scenario?.trim()) parts.push(`【场景设定】\n${data.scenario.trim()}`);

    const book = data.character_book?.entries;
    if (book) {
        const enabled = Object.values(book).filter(e => e.enabled && e.content?.trim());
        if (enabled.length > 0) {
            const bookText = enabled.map(e => `[${e.name || e.comment || '条目'}] ${e.content.trim()}`).join('\n');
            parts.push(`【世界书】\n${bookText}`);
        }
    }

    return parts.join('\n\n');
}

// 压缩目标：聊天记录
function getChatText() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    if (!chat || chat.length === 0) return '';

    return chat
        .filter(m => m.mes && !m.is_system)
        .map(m => {
            const role = m.is_user ? '用户' : (m.name || '角色');
            return `${role}: ${m.mes.trim()}`;
        })
        .join('\n');
}

// ==================== UI 事件绑定 ====================
function bindUIEvents(settings) {
    $('#tokenslim_enabled').on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        if (!settings.enabled) removeFCC();
        else if (currentFCC) injectFCC(currentFCC);
    });

    $('#tokenslim_format').on('change', function () {
        settings.format = String($(this).val());
        saveSettingsDebounced();
        updateFormatExample();
    });

    $('#tokenslim_token_target').on('input', function () {
        settings.tokenTarget = parseInt(String($(this).val())) || 300;
        saveSettingsDebounced();
    });

    $('#tokenslim_feynman').on('change', function () {
        settings.feynmanCheck = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#tokenslim_auto_inject').on('change', function () {
        settings.autoInject = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#tokenslim_generate_btn').on('click', async () => await handleGenerateFCC(settings));
    $('#tokenslim_rebuild_btn').on('click', async () => await handleGenerateFCC(settings));
    $('#tokenslim_clear_btn').on('click', () => handleClearFCC(settings));
    $('#tokenslim_add_patch_btn').on('click', () => handleAddPatch(settings));
    $('#tokenslim_fold_patches_btn').on('click', async () => await handleFoldPatches(settings));
    $('#tokenslim_cache_check_btn').on('click', () => handleCacheCheck());
}

// ==================== 生成 FCC ====================
async function handleGenerateFCC(settings) {
    const aiCheck = checkAIAvailable();
    if (!aiCheck.available) {
        toastr.error(aiCheck.reason, 'TokenSlim - 需要配置AI');
        return;
    }

    const charData = getCurrentCharacterData();
    if (!charData) {
        toastr.error('请先打开一个角色的聊天', 'TokenSlim');
        return;
    }

    const chatText = getChatText();
    if (!chatText.trim()) {
        toastr.error('当前没有聊天记录可压缩', 'TokenSlim');
        return;
    }

    const btn = $('#tokenslim_generate_btn');
    const originalBtnText = btn.html();
    btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 压缩中...').prop('disabled', true);

    try {
        const refContext = getReferenceContext(charData);
        const originalTokens = await countTokens(chatText);
        const refTokens = refContext ? await countTokens(refContext) : 0;

        toastr.info(`聊天记录 ${originalTokens}tok | 参考上下文 ${refTokens}tok | 格式: ${FORMAT_OPTIONS[settings.format]?.name || settings.format}`, 'TokenSlim 开始压缩');

        // 核心压缩：一轮高质量压缩（不再5轮，信息损失太大）
        let compressed = await compressChat(chatText, refContext, settings);

        // 可选：Feynman 自检
        let selfCheckResult = null;
        if (settings.feynmanCheck) {
            selfCheckResult = await feynmanSelfCheck(compressed, chatText, refContext);
            if (selfCheckResult.gaps && !selfCheckResult.gaps.includes('无关键遗漏')) {
                compressed += '\n\n[自检补充] ' + selfCheckResult.gaps;
            }
        }

        const compressedTokens = await countTokens(compressed);
        const ratio = originalTokens > 0 ? (compressedTokens / originalTokens) : 0;

        currentFCC = {
            fcc_version: 2,
            generated_at: new Date().toISOString(),
            format: settings.format,
            content: {
                raw: compressed,
                token_count: compressedTokens,
                original_token_count: originalTokens,
                compression_ratio: ratio,
            },
            patches: [],
        };

        saveFCC(currentFCC);
        if (settings.enabled && settings.autoInject) injectFCC(currentFCC);

        updateUIState(settings);
        updateCompressionResult(originalTokens, compressedTokens, ratio, selfCheckResult);

        toastr.success(`FCC 已生成！${originalTokens} → ${compressedTokens} tok（节省 ${Math.round((1 - ratio) * 100)}%）`, 'TokenSlim');
    } catch (err) {
        console.error('TokenSlim: FCC 生成失败', err);
        toastr.error('生成失败：' + err.message, 'TokenSlim');
    } finally {
        btn.html(originalBtnText).prop('disabled', false);
    }
}

// ==================== 核心压缩函数 ====================
async function compressChat(chatText, refContext, settings) {
    const ctx = SillyTavern.getContext();
    const format = FORMAT_OPTIONS[settings.format] || FORMAT_OPTIONS.timeline;
    const targetTokens = settings.tokenTarget || 300;

    const prompt = `你是一个专业的故事摘要师。你的任务是将聊天记录压缩为精炼的摘要，保留所有对后续角色扮演有影响的关键信息。

## 参考信息（角色的身份和设定，不需要压缩）
${refContext || '（无参考信息）'}

## 待压缩的聊天记录
${chatText}

## 压缩要求
1. 格式：${format.name}（${format.desc}）
2. 参考示例：${format.example}
3. 目标：约 ${targetTokens} tokens，宁可保留关键信息也不要遗漏
4. 必须保留：关键事件、关系变化、情感转折、重要承诺/约定、角色新发现
5. 可以省略：寒暄、重复内容、无关紧要的闲聊细节
6. 不要添加原文中没有的信息

## 输出
直接输出压缩结果，不要任何前缀、解释或标注。`;

    try {
        const result = await ctx.generateQuietPrompt({ quietPrompt: prompt });
        return (result || chatText).trim();
    } catch (err) {
        console.warn('TokenSlim: 压缩失败，返回原文片段', err);
        // 降级：截取最后部分聊天记录
        const lines = chatText.split('\n');
        const halfLines = lines.slice(-Math.ceil(lines.length / 3));
        return halfLines.join('\n');
    }
}

// ==================== Feynman 自检 ====================
async function feynmanSelfCheck(compressed, originalChat, refContext) {
    try {
        const ctx = SillyTavern.getContext();
        const prompt = `你是质量检查员。对比以下聊天原文和压缩结果，检查是否有对后续角色扮演有影响的关键信息被遗漏。

## 参考设定
${refContext || '（无）'}

## 聊天原文（截取）
${originalChat.substring(0, 3000)}

## 压缩结果
${compressed}

如果压缩结果已包含所有关键信息，回复"无关键遗漏"。
否则，用一句话列出遗漏的关键信息（如"遗漏了：XXX承诺了YYY"）。`;

        const result = await ctx.generateQuietPrompt({ quietPrompt: prompt });
        const gaps = (result || '').trim();
        const score = gaps.includes('无关键遗漏') || gaps.includes('没有遗漏') ? 95 :
                      gaps.split('\n').filter(l => l.trim()).length <= 1 ? 80 : 50;
        return { gaps, quality_score: score };
    } catch (err) {
        console.warn('TokenSlim: 自检失败', err);
        return { gaps: '', quality_score: -1 };
    }
}

// ==================== 清除 FCC ====================
function handleClearFCC(settings) {
    removeFCC();
    currentFCC = null;
    const key = getCharacterKey();
    if (key && settings.charData) {
        delete settings.charData[key];
        saveSettingsDebounced();
    }
    updateUIState(settings);
    toastr.info('FCC 已清除', 'TokenSlim');
}

// ==================== 补丁操作 ====================
function handleAddPatch(settings) {
    const input = $('#tokenslim_patch_input');
    const content = String(input.val()).trim();
    if (!content) { toastr.warning('请输入补丁内容', 'TokenSlim'); return; }
    if (!currentFCC) { toastr.error('请先生成 FCC', 'TokenSlim'); return; }

    if (!currentFCC.patches) currentFCC.patches = [];
    currentFCC.patches.push({
        seq: currentFCC.patches.length + 1,
        timestamp: new Date().toISOString(),
        content,
    });
    currentFCC.content.token_count += Math.ceil(content.length / 2);

    saveFCC(currentFCC);
    injectFCC(currentFCC);
    input.val('');
    updateUIState(settings);
    toastr.success('补丁已添加', 'TokenSlim');
}

async function handleFoldPatches(settings) {
    if (!currentFCC?.patches?.length) { toastr.info('没有需要折叠的补丁', 'TokenSlim'); return; }

    try {
        const ctx = SillyTavern.getContext();
        const patchText = currentFCC.patches.map(p => `[${p.seq}] ${p.content}`).join('\n');
        const prompt = `将以下增量更新压缩为最精炼的摘要，保留所有关键变化，不要丢失任何重要信息。\n\n${patchText}\n\n压缩结果：`;
        const folded = await ctx.generateQuietPrompt({ quietPrompt: prompt });

        currentFCC.content.raw += '\n\n[更新] ' + (folded || patchText).trim();
        currentFCC.content.token_count = await countTokens(currentFCC.content.raw);
        currentFCC.patches = [];

        saveFCC(currentFCC);
        injectFCC(currentFCC);
        updateUIState(settings);
        toastr.success('补丁已折叠', 'TokenSlim');
    } catch (err) {
        console.error('TokenSlim: 补丁折叠失败', err);
        toastr.error('折叠失败：' + err.message, 'TokenSlim');
    }
}

// ==================== 缓存健康度 ====================
function handleCacheCheck() {
    const result = detectCacheKillers();
    const panel = $('#tokenslim_cache_result');
    panel.empty();

    const cls = result.score >= 80 ? 'tokenslim-cache-good' : result.score >= 50 ? 'tokenslim-cache-warn' : 'tokenslim-cache-bad';
    panel.append(`<div class="${cls}">缓存健康度: ${result.score}/100 ${result.score >= 80 ? '✓' : result.score >= 50 ? '⚠' : '✗'}</div>`);

    for (const issue of result.issues) {
        const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'high' ? '🟡' : '🟢';
        panel.append(`<div class="tokenslim-cache-issue">${icon} ${issue.description} → ${issue.fix}</div>`);
    }

    const strategy = getCacheStrategy();
    panel.append(`<div class="tokenslim-cache-strategy">
        API: ${strategy.provider} | 最小前缀: ${strategy.minPrefixTokens}tok |
        cache_control: ${strategy.supportsCacheControl ? '✓' : '✗'} |
        命中折扣: ${Math.round((1 - strategy.discount) * 100)}%off
    </div>`);
}

// ==================== UI 更新 ====================
function updateUIState(settings) {
    const hasFCC = !!currentFCC;

    $('#tokenslim_enabled').prop('checked', settings.enabled);
    $('#tokenslim_format').val(settings.format);
    $('#tokenslim_token_target').val(settings.tokenTarget);
    $('#tokenslim_feynman').prop('checked', settings.feynmanCheck);
    $('#tokenslim_auto_inject').prop('checked', settings.autoInject);

    if (hasFCC) {
        const fmtName = FORMAT_OPTIONS[currentFCC.format]?.name || currentFCC.format || '未知';
        $('#tokenslim_status').html(`<span class="tokenslim-status-active">✅ FCC 已生成 (${fmtName})</span>`);
        $('#tokenslim_rebuild_btn, #tokenslim_clear_btn').show();
        $('#tokenslim_fcc_content').val(currentFCC.content.raw).show();
        $('#tokenslim_fcc_meta').html(
            `生成于: ${(currentFCC.generated_at || '').split('T')[0]} | ` +
            `${currentFCC.content.original_token_count} → ${currentFCC.content.token_count} tok | ` +
            `节省 ${Math.round((1 - currentFCC.content.compression_ratio) * 100)}%`
        ).show();

        if (currentFCC.patches?.length > 0) {
            $('#tokenslim_patches_list').text(
                currentFCC.patches.map(p => `[${p.seq}] ${p.content}`).join('\n')
            ).show();
            $('#tokenslim_fold_patches_btn').show();
        } else {
            $('#tokenslim_patches_list').hide();
            $('#tokenslim_fold_patches_btn').hide();
        }
    } else {
        $('#tokenslim_status').html('<span class="tokenslim-status-inactive">⬜ FCC 未生成</span>');
        $('#tokenslim_rebuild_btn, #tokenslim_clear_btn, #tokenslim_fcc_content, #tokenslim_fcc_meta, #tokenslim_patches_list, #tokenslim_fold_patches_btn').hide();
    }

    updateFormatExample();
}

function updateFormatExample() {
    const fmt = FORMAT_OPTIONS[$('#tokenslim_format').val() || 'timeline'];
    if (fmt) {
        $('#tokenslim_format_example').text(fmt.example);
    }
}

function updateCompressionResult(originalTokens, compressedTokens, ratio, selfCheckResult) {
    const savePercent = Math.round((1 - ratio) * 100);
    $('#tokenslim_compress_result').html(`
        <div class="tokenslim-result-row">
            <span>原始: ${originalTokens} tok</span>
            <span>→</span>
            <span>压缩后: ${compressedTokens} tok</span>
        </div>
        <div class="tokenslim-result-bar">
            <div class="tokenslim-result-fill" style="width: ${savePercent}%"></div>
        </div>
        <div class="tokenslim-result-save">节省 ${savePercent}%</div>
        ${selfCheckResult?.quality_score > 0 ? `<div class="tokenslim-result-feynman">自检评分: ${selfCheckResult.quality_score}分</div>` : ''}
    `).show();
}

// ==================== FCC 存储（extension_settings） ====================
function loadFCC() {
    const settings = extension_settings[EXT_NAME];
    if (!settings?.charData) return null;
    const key = getCharacterKey();
    if (!key) return null;
    return settings.charData[key]?.fcc || null;
}

function saveFCC(fcc) {
    const settings = extension_settings[EXT_NAME];
    if (!settings.charData) settings.charData = {};
    const key = getCharacterKey();
    if (!key) { console.warn('TokenSlim: 无法保存，角色标识缺失'); return; }
    settings.charData[key] = { fcc };
    saveSettingsDebounced();
    console.log('TokenSlim: FCC 已保存', key);
}

// ==================== FCC 注入 ====================
function injectFCC(fcc) {
    try {
        const ctx = SillyTavern.getContext();
        let content = fcc.content.raw;
        if (fcc.patches?.length > 0) {
            content += '\n\n=== 增量更新 ===\n' + fcc.patches.map(p => `[${p.seq}] ${p.content}`).join('\n');
        }
        ctx.setExtensionPrompt(EXT_KEY, content, FCC_POSITION, FCC_DEPTH, FCC_SCAN, 0);
        console.log('TokenSlim: FCC 已注入', { tokenCount: fcc.content?.token_count });
    } catch (err) {
        console.error('TokenSlim: FCC 注入失败', err);
    }
}

function removeFCC() {
    try {
        const ctx = SillyTavern.getContext();
        ctx.setExtensionPrompt(EXT_KEY, '', FCC_POSITION, FCC_DEPTH, FCC_SCAN, 0);
    } catch (err) {
        console.error('TokenSlim: FCC 移除失败', err);
    }
}

function ensureFCCInjected() {
    if (!currentFCC) currentFCC = loadFCC();
    if (currentFCC?.content?.raw) injectFCC(currentFCC);
}

// ==================== Token 计数 ====================
async function countTokens(text, padding = 0) {
    try {
        const ctx = SillyTavern.getContext();
        return await ctx.getTokenCountAsync(text, padding);
    } catch {
        const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const en = text.length - cn;
        return Math.ceil(cn / 2 + en / 4) + padding;
    }
}

// ==================== 缓存策略 ====================
function getCacheStrategy() {
    try {
        const api = SillyTavern.getContext().mainApi || 'unknown';
        const map = {
            anthropic: { provider: 'anthropic', minPrefixTokens: 1024, supportsCacheControl: true, discount: 0.1 },
            openai: { provider: 'openai', minPrefixTokens: 1024, supportsCacheControl: false, discount: 0.5 },
            openaichat: { provider: 'openai', minPrefixTokens: 1024, supportsCacheControl: false, discount: 0.5 },
            deepseek: { provider: 'deepseek', minPrefixTokens: 0, supportsCacheControl: false, discount: 0.1 },
        };
        return map[api] || { provider: api, minPrefixTokens: 1024, supportsCacheControl: false, discount: 0 };
    } catch {
        return { provider: 'unknown', minPrefixTokens: 1024, supportsCacheControl: false, discount: 0 };
    }
}

// ==================== 缓存杀手检测 ====================
function detectCacheKillers() {
    const issues = [];
    try {
        const ctx = SillyTavern.getContext();
        const sysPrompt = ctx.powerUserSettings?.sysprompt?.content || '';
        if (/current_time|当前时间|今天是|\{\{time\}\}|\{\{date\}\}/i.test(sysPrompt)) {
            issues.push({ severity: 'critical', description: '系统提示含时间戳变量', fix: '时间戳放最后或别放' });
        }
        if (currentFCC && currentFCC.content?.token_count < 1024) {
            issues.push({ severity: 'medium', description: `FCC 仅 ${currentFCC.content.token_count} tokens（需 ≥ 1024）`, fix: '增加 FCC 内容或 token 目标' });
        }
        const charData = getCurrentCharacterData();
        if (charData) {
            const book = charData.char?.data?.character_book?.entries;
            if (book) {
                const depthEntries = Object.values(book).filter(e => e.enabled && e.position === 4 && e.depth > 0 && e.depth < 9999);
                if (depthEntries.length > 0) {
                    issues.push({ severity: 'high', description: `${depthEntries.length} 个 Dn 深度注入条目`, fix: '考虑移到 D0 或 D9999' });
                }
            }
        }
    } catch {
        issues.push({ severity: 'medium', description: '缓存检测执行异常', fix: '检查连接状态' });
    }

    let score = 100;
    for (const issue of issues) {
        score -= issue.severity === 'critical' ? 30 : issue.severity === 'high' ? 15 : 5;
    }
    return { score: Math.max(0, Math.min(100, score)), issues };
}
