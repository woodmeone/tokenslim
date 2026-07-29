/**
 * TokenSlim - 角色卡省Token插件
 * 通过 FCC（冻结压缩典籍）实现角色卡文本压缩 + 缓存命中率优化
 */

import { extension_settings, saveMetadataDebounced, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

// ==================== 常量 ====================
const EXT_KEY = 'tokenslim_fcc';
const EXT_NAME = 'tokenslim';
const EXT_DISPLAY_NAME = 'third-party/tokenslim';
const EXT_FOLDER = `scripts/extensions/${EXT_DISPLAY_NAME}`;
const FCC_POSITION = 1;  // before_char
const FCC_DEPTH = 0;
const FCC_SCAN = false;
const DEFAULT_TOKEN_TARGET = 150;
const DEFAULT_FORMAT = 'plist';

// ==================== 默认设置 ====================
const defaultSettings = {
    enabled: true,
    format: DEFAULT_FORMAT,
    tokenTarget: DEFAULT_TOKEN_TARGET,
    archetypeAnchoring: true,
    schemaCompression: true,
    feynmanCheck: true,
    autoInject: true,
    chineseTokenTaxOpt: 'off',
};

// ==================== 扩展状态 ====================
let currentFCC = null;

// ==================== 初始化（jQuery 自动执行） ====================
jQuery(async () => {
    console.log('TokenSlim: 初始化...');

    // 初始化设置
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...defaultSettings };
    }
    const settings = extension_settings[EXT_NAME];

    // 渲染设置面板
    const settingsHtml = await $.get(`${EXT_FOLDER}/settings.html`);
    $('#extensions_settings').append(settingsHtml);

    // 绑定 UI 事件
    bindUIEvents(settings);

    // 监听事件：角色卡加载时注入 FCC
    const ctx = SillyTavern.getContext();
    ctx.eventSource.on(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, () => {
        if (settings.autoInject) {
            ensureFCCInjected();
        }
    });

    // 监听事件：生成前兜底注入
    ctx.eventSource.on(ctx.eventTypes.GENERATION_AFTER_COMMANDS, () => {
        if (settings.autoInject) {
            ensureFCCInjected();
        }
    });

    // 加载当前角色卡的 FCC
    currentFCC = loadFCC();
    if (currentFCC && settings.autoInject) {
        injectFCC(currentFCC);
    }

    // 更新 UI 状态
    updateUIState(settings);

    console.log('TokenSlim: 初始化完成');
});

// ==================== UI 事件绑定 ====================
function bindUIEvents(settings) {
    // 启用/禁用
    $('#tokenslim_enabled').on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        if (!settings.enabled) {
            removeFCC();
        } else if (currentFCC) {
            injectFCC(currentFCC);
        }
    });

    // 格式选择
    $('#tokenslim_format').on('change', function () {
        settings.format = String($(this).val());
        saveSettingsDebounced();
    });

    // Token 目标
    $('#tokenslim_token_target').on('input', function () {
        settings.tokenTarget = parseInt(String($(this).val())) || DEFAULT_TOKEN_TARGET;
        saveSettingsDebounced();
    });

    // 原型锚点
    $('#tokenslim_archetype').on('change', function () {
        settings.archetypeAnchoring = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    // Schema 压缩
    $('#tokenslim_schema').on('change', function () {
        settings.schemaCompression = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    // Feynman 自检
    $('#tokenslim_feynman').on('change', function () {
        settings.feynmanCheck = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    // 自动注入
    $('#tokenslim_auto_inject').on('change', function () {
        settings.autoInject = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    // 中文 token 税规避
    $('#tokenslim_chinese_tax').on('change', function () {
        settings.chineseTokenTaxOpt = String($(this).val());
        saveSettingsDebounced();
    });

    // 生成 FCC 按钮
    $('#tokenslim_generate_btn').on('click', async function () {
        await handleGenerateFCC(settings);
    });

    // 重建 FCC 按钮
    $('#tokenslim_rebuild_btn').on('click', async function () {
        await handleGenerateFCC(settings);
    });

    // 清除 FCC 按钮
    $('#tokenslim_clear_btn').on('click', function () {
        handleClearFCC(settings);
    });

    // 添加补丁按钮
    $('#tokenslim_add_patch_btn').on('click', function () {
        handleAddPatch(settings);
    });

    // 折叠补丁按钮
    $('#tokenslim_fold_patches_btn').on('click', async function () {
        await handleFoldPatches(settings);
    });

    // 缓存健康度检测按钮
    $('#tokenslim_cache_check_btn').on('click', function () {
        handleCacheCheck();
    });
}

// ==================== 生成 FCC ====================
async function handleGenerateFCC(settings) {
    const btn = $('#tokenslim_generate_btn');
    const originalBtnText = btn.html();
    btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...').prop('disabled', true);

    try {
        const ctx = SillyTavern.getContext();
        const charId = ctx.characterId;
        if (charId === undefined || charId === null) {
            toastr.error('请先加载角色卡', 'TokenSlim');
            return;
        }

        const char = ctx.characters[charId];
        if (!char || !char.data) {
            toastr.error('请先加载角色卡', 'TokenSlim');
            return;
        }

        const description = char.data.description || '';
        const personality = char.data.personality || '';
        const scenario = char.data.scenario || '';
        const allOriginalText = [description, personality, scenario].filter(Boolean).join('\n\n');

        if (!allOriginalText.trim()) {
            toastr.error('角色卡文本为空', 'TokenSlim');
            return;
        }

        // 计算原始 token 数
        const originalTokens = await countTokens(allOriginalText);

        // 执行压缩管线
        let compressedContent = await compressPipeline(allOriginalText, settings);

        // Feynman 自检
        let selfCheckResult = null;
        if (settings.feynmanCheck) {
            selfCheckResult = await feynmanSelfCheck(compressedContent, allOriginalText);
            if (selfCheckResult.gaps && selfCheckResult.gaps !== '无关键遗漏') {
                compressedContent += '\n' + selfCheckResult.gaps;
            }
        }

        // 计算压缩后 token 数
        const compressedTokens = await countTokens(compressedContent);
        const ratio = originalTokens > 0 ? (compressedTokens / originalTokens) : 0;

        // 生成 FCC 数据结构
        currentFCC = {
            fcc_version: 1,
            generated_at: new Date().toISOString(),
            source_hash: await hashText(allOriginalText),
            compressor_version: '1.0.0',
            content: {
                raw: compressedContent,
                token_count: compressedTokens,
                original_token_count: originalTokens,
                compression_ratio: ratio,
            },
            patches: [],
        };

        // 保存 FCC 到角色卡扩展字段
        await saveFCC(currentFCC);

        // 注入 FCC
        injectFCC(currentFCC);

        // 更新 UI
        updateUIState(settings);
        updateCompressionResult(originalTokens, compressedTokens, ratio, selfCheckResult);

        toastr.success(`FCC 已生成！${originalTokens} → ${compressedTokens} tokens（节省 ${Math.round((1 - ratio) * 100)}%）`, 'TokenSlim');
    } catch (err) {
        console.error('TokenSlim: FCC 生成失败', err);
        toastr.error('FCC 生成失败：' + err.message, 'TokenSlim');
    } finally {
        btn.html(originalBtnText).prop('disabled', false);
    }
}

// ==================== 清除 FCC ====================
function handleClearFCC(settings) {
    removeFCC();
    currentFCC = null;
    clearFCC();
    updateUIState(settings);
    toastr.info('FCC 已清除', 'TokenSlim');
}

// ==================== 添加补丁 ====================
function handleAddPatch(settings) {
    const input = $('#tokenslim_patch_input');
    const content = String(input.val()).trim();
    if (!content) {
        toastr.warning('请输入补丁内容', 'TokenSlim');
        return;
    }

    if (!currentFCC) {
        toastr.error('请先生成 FCC', 'TokenSlim');
        return;
    }

    appendPatch(currentFCC, content);
    saveFCC(currentFCC);

    // 重新注入
    injectFCC(currentFCC);

    input.val('');
    updateUIState(settings);
    toastr.success('补丁已添加', 'TokenSlim');
}

// ==================== 折叠补丁 ====================
async function handleFoldPatches(settings) {
    if (!currentFCC || !currentFCC.patches || currentFCC.patches.length === 0) {
        toastr.info('没有需要折叠的补丁', 'TokenSlim');
        return;
    }

    try {
        await foldPatches(currentFCC);
        await saveFCC(currentFCC);

        injectFCC(currentFCC);

        updateUIState(settings);
        toastr.success('补丁已折叠', 'TokenSlim');
    } catch (err) {
        console.error('TokenSlim: 补丁折叠失败', err);
        toastr.error('补丁折叠失败：' + err.message, 'TokenSlim');
    }
}

// ==================== 缓存健康度检测 ====================
function handleCacheCheck() {
    const result = detectCacheKillers();
    const panel = $('#tokenslim_cache_result');
    panel.empty();

    if (result.score >= 80) {
        panel.append(`<div class="tokenslim-cache-good">缓存健康度: ${result.score}/100 ✓</div>`);
    } else if (result.score >= 50) {
        panel.append(`<div class="tokenslim-cache-warn">缓存健康度: ${result.score}/100 ⚠</div>`);
    } else {
        panel.append(`<div class="tokenslim-cache-bad">缓存健康度: ${result.score}/100 ✗</div>`);
    }

    for (const issue of result.issues) {
        panel.append(`<div class="tokenslim-cache-issue tokenslim-cache-${issue.severity}">
            ${issue.severity === 'critical' ? '🔴' : issue.severity === 'high' ? '🟡' : '🟢'}
            ${issue.description} → 建议: ${issue.fix}
        </div>`);
    }

    const strategy = getCacheStrategy();
    panel.append(`<div class="tokenslim-cache-strategy">
        当前API: ${strategy.provider} | 最小前缀: ${strategy.minPrefixTokens}tok |
        cache_control: ${strategy.supportsCacheControl ? '✓' : '✗'} |
        命中折扣: ${Math.round((1 - strategy.discount) * 100)}%off
    </div>`);
}

// ==================== UI 状态更新 ====================
function updateUIState(settings) {
    const hasFCC = !!currentFCC;

    $('#tokenslim_enabled').prop('checked', settings.enabled);
    $('#tokenslim_format').val(settings.format);
    $('#tokenslim_token_target').val(settings.tokenTarget);
    $('#tokenslim_archetype').prop('checked', settings.archetypeAnchoring);
    $('#tokenslim_schema').prop('checked', settings.schemaCompression);
    $('#tokenslim_feynman').prop('checked', settings.feynmanCheck);
    $('#tokenslim_auto_inject').prop('checked', settings.autoInject);
    $('#tokenslim_chinese_tax').val(settings.chineseTokenTaxOpt);

    if (hasFCC) {
        $('#tokenslim_status').html('<span class="tokenslim-status-active">✅ FCC 已生成</span>');
        $('#tokenslim_rebuild_btn').show();
        $('#tokenslim_clear_btn').show();
        $('#tokenslim_fcc_content').val(currentFCC.content.raw).show();
        $('#tokenslim_fcc_meta').html(
            `生成于: ${currentFCC.generated_at?.split('T')[0] || '未知'} | ` +
            `Token: ${currentFCC.content.token_count} | ` +
            `压缩比: ${Math.round((1 - currentFCC.content.compression_ratio) * 100)}% 节省`
        ).show();

        if (currentFCC.patches && currentFCC.patches.length > 0) {
            const patchList = currentFCC.patches.map(p =>
                `[${p.seq}] ${p.content} (${p.tokens}tok)`
            ).join('\n');
            $('#tokenslim_patches_list').text(patchList).show();
            $('#tokenslim_fold_patches_btn').show();
        } else {
            $('#tokenslim_patches_list').hide();
            $('#tokenslim_fold_patches_btn').hide();
        }
    } else {
        $('#tokenslim_status').html('<span class="tokenslim-status-inactive">⬜ FCC 未生成</span>');
        $('#tokenslim_rebuild_btn').hide();
        $('#tokenslim_clear_btn').hide();
        $('#tokenslim_fcc_content').hide();
        $('#tokenslim_fcc_meta').hide();
        $('#tokenslim_patches_list').hide();
        $('#tokenslim_fold_patches_btn').hide();
    }
}

// ==================== 压缩结果更新 ====================
function updateCompressionResult(originalTokens, compressedTokens, ratio, selfCheckResult) {
    const panel = $('#tokenslim_compress_result');
    panel.html(`
        <div class="tokenslim-result-row">
            <span>原始: ${originalTokens} tokens</span>
            <span>→</span>
            <span>压缩后: ${compressedTokens} tokens</span>
        </div>
        <div class="tokenslim-result-bar">
            <div class="tokenslim-result-fill" style="width: ${Math.round((1 - ratio) * 100)}%"></div>
        </div>
        <div class="tokenslim-result-save">节省 ${Math.round((1 - ratio) * 100)}%</div>
        ${selfCheckResult ? `<div class="tokenslim-result-feynman">Feynman自检: ${selfCheckResult.quality_score || 'N/A'}分</div>` : ''}
    `).show();
}

// ==================== FCC 加载/保存/清除 ====================
function loadFCC() {
    try {
        const ctx = SillyTavern.getContext();
        const charId = ctx.characterId;
        if (charId === undefined || charId === null) return null;
        const char = ctx.characters[charId];
        return char?.data?.extensions?.tokenslim?.fcc || null;
    } catch (err) {
        console.warn('TokenSlim: FCC 加载失败', err);
        return null;
    }
}

async function saveFCC(fcc) {
    try {
        const ctx = SillyTavern.getContext();
        const charId = ctx.characterId;
        if (charId === undefined || charId === null) {
            console.warn('TokenSlim: 无法保存 FCC，角色卡未加载');
            return;
        }
        await ctx.writeExtensionField(charId, 'tokenslim', { fcc: fcc });
        console.log('TokenSlim: FCC 已保存');
    } catch (err) {
        console.error('TokenSlim: FCC 保存失败', err);
    }
}

function clearFCC() {
    try {
        const ctx = SillyTavern.getContext();
        const charId = ctx.characterId;
        if (charId === undefined || charId === null) return;
        const char = ctx.characters[charId];
        if (char?.data?.extensions?.tokenslim) {
            delete char.data.extensions.tokenslim.fcc;
            saveMetadataDebounced();
        }
    } catch (err) {
        console.error('TokenSlim: FCC 清除失败', err);
    }
}

// ==================== FCC 注入 ====================
function injectFCC(fcc) {
    try {
        const ctx = SillyTavern.getContext();
        let content = fcc.content.raw;

        if (fcc.patches && fcc.patches.length > 0) {
            content += '\n\n=== 增量更新 ===\n';
            content += fcc.patches.map(p => `[${p.seq}] ${p.content}`).join('\n');
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
        console.log('TokenSlim: FCC 注入已移除');
    } catch (err) {
        console.error('TokenSlim: FCC 移除失败', err);
    }
}

function ensureFCCInjected() {
    try {
        if (!currentFCC) {
            currentFCC = loadFCC();
        }
        if (currentFCC && currentFCC.content?.raw) {
            injectFCC(currentFCC);
        }
    } catch (err) {
        console.warn('TokenSlim: FCC 兜底注入失败', err);
    }
}

// ==================== 补丁操作 ====================
async function appendPatch(fcc, content) {
    if (!fcc.patches) fcc.patches = [];
    const seq = fcc.patches.length + 1;
    const tokens = await countTokens(content);
    fcc.patches.push({
        seq,
        timestamp: new Date().toISOString(),
        trigger_reason: 'user_manual',
        content: content,
        tokens,
    });
    fcc.content.token_count += tokens;
    console.log(`TokenSlim: 补丁 #${seq} 已追加（${tokens}tok）`);
}

async function foldPatches(fcc) {
    if (!fcc.patches || fcc.patches.length === 0) return;
    const ctx = SillyTavern.getContext();
    const patchContents = fcc.patches.map(p => `[${p.seq}] ${p.content}`).join('\n');
    const foldPrompt = `将以下增量更新压缩为最精炼的摘要，保留所有关键变化。\n\n增量更新：\n${patchContents}\n\n压缩结果：`;
    const foldedContent = await ctx.generateQuietPrompt({ quietPrompt: foldPrompt });
    fcc.content.raw += '\n\n=== 折叠更新 ===\n' + (foldedContent || patchContents).trim();
    fcc.content.token_count = await countTokens(fcc.content.raw);
    fcc.patches = [];
    console.log('TokenSlim: 补丁已折叠');
}

// ==================== 压缩管线 ====================
async function compressPipeline(originalText, settings) {
    const ctx = SillyTavern.getContext();

    // L1 删废话
    const l1 = await llmCompress(ctx, originalText, DELETE_FILLER_PROMPT);
    console.log('TokenSlim: L1 删废话完成');

    // L2 类型化压缩
    const textType = classifyText(originalText);
    const l2Prompt = TYPE_SPECIFIC_PROMPT[textType] || TYPE_SPECIFIC_PROMPT.default;
    const l2 = await llmCompress(ctx, l1, l2Prompt);
    console.log('TokenSlim: L2 类型化压缩完成');

    // L3 结构化
    const l3Prompt = getFormatPrompt(settings.format, settings.tokenTarget);
    const l3 = await llmCompress(ctx, l2, l3Prompt);
    console.log('TokenSlim: L3 结构化完成');

    // L4 原型锚点
    let l4 = l3;
    if (settings.archetypeAnchoring) {
        l4 = await llmCompress(ctx, l3, ARCHETYPE_PROMPT);
        console.log('TokenSlim: L4 原型锚点完成');
    }

    // L5 一句话总结
    const l5 = await llmCompress(ctx, l4, SUMMARY_PROMPT);
    console.log('TokenSlim: L5 一句话总结完成');

    // 中文 token 税规避
    let result = l5;
    if (settings.chineseTokenTaxOpt !== 'off') {
        result = applyChineseTokenTaxOpt(result, settings.chineseTokenTaxOpt);
    }

    return result;
}

async function llmCompress(ctx, text, prompt) {
    try {
        const fullPrompt = `${prompt}\n\n## 输入\n${text}\n\n## 输出\n直接输出结果，不要任何前缀或解释。`;
        const result = await ctx.generateQuietPrompt({ quietPrompt: fullPrompt });
        return (result || text).trim();
    } catch (err) {
        console.warn('TokenSlim: LLM 压缩失败，返回原文', err);
        return text;
    }
}

// ==================== Feynman 自检 ====================
async function feynmanSelfCheck(compressedContent, originalText) {
    try {
        const ctx = SillyTavern.getContext();
        const gapsPrompt = `对比以下原文与压缩版，仅列出压缩版中遗漏的对角色演绎有影响的关键信息。如果没有关键遗漏，回复"无关键遗漏"。\n\n原文：${originalText.substring(0, 2000)}\n压缩：${compressedContent}\n\n遗漏的关键信息：`;
        const gaps = await ctx.generateQuietPrompt({ quietPrompt: gapsPrompt });
        const qualityScore = calculateQualityScore(gaps);
        return { gaps: (gaps || '').trim(), quality_score: qualityScore };
    } catch (err) {
        console.warn('TokenSlim: Feynman 自检失败', err);
        return { gaps: '自检失败', quality_score: -1 };
    }
}

function calculateQualityScore(gaps) {
    if (!gaps) return 80;
    const trimmed = gaps.trim();
    if (trimmed.includes('无关键遗漏') || trimmed.includes('没有遗漏')) return 95;
    const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
    const gapCount = Math.max(lines.length, 1);
    if (gapCount <= 1) return 80;
    if (gapCount <= 3) return 65;
    if (gapCount <= 5) return 50;
    return 30;
}

// ==================== Token 计数 ====================
async function countTokens(text, padding = 0) {
    try {
        const ctx = SillyTavern.getContext();
        return await ctx.getTokenCountAsync(text, padding);
    } catch (err) {
        console.warn('TokenSlim: Token 计数失败，使用估算', err);
        const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const otherChars = text.length - chineseChars;
        return Math.ceil(chineseChars / 2 + otherChars / 4) + padding;
    }
}

// ==================== 缓存策略 ====================
function getCacheStrategy() {
    try {
        const ctx = SillyTavern.getContext();
        const apiType = ctx.mainApi || 'unknown';
        const strategies = {
            anthropic: { provider: 'anthropic', minPrefixTokens: 1024, supportsCacheControl: true, ttl: 300, discount: 0.1 },
            openai: { provider: 'openai', minPrefixTokens: 1024, supportsCacheControl: false, ttl: 600, discount: 0.5 },
            openaichat: { provider: 'openai', minPrefixTokens: 1024, supportsCacheControl: false, ttl: 600, discount: 0.5 },
            openaiendpoint: { provider: 'openai-compatible', minPrefixTokens: 1024, supportsCacheControl: false, ttl: 600, discount: 0.5 },
            deepseek: { provider: 'deepseek', minPrefixTokens: 0, supportsCacheControl: false, ttl: 0, discount: 0.1 },
        };
        return strategies[apiType] || { provider: apiType, minPrefixTokens: 1024, supportsCacheControl: false, ttl: 0, discount: 0 };
    } catch (err) {
        return { provider: 'unknown', minPrefixTokens: 1024, supportsCacheControl: false, ttl: 0, discount: 0 };
    }
}

// ==================== 缓存杀手检测 ====================
function detectCacheKillers() {
    const issues = [];
    try {
        const ctx = SillyTavern.getContext();
        const charId = ctx.characterId;

        // 规则1：系统提示含时间戳
        const sysPrompt = ctx.powerUserSettings?.sysprompt?.content || '';
        if (/current_time|当前时间|今天是|\{\{time\}\}|\{\{date\}\}/i.test(sysPrompt)) {
            issues.push({ severity: 'critical', description: '系统提示含时间戳变量', fix: '时间戳放最后或别放' });
        }

        // 规则2：FCC 前缀长度不足
        if (currentFCC && currentFCC.content?.token_count < 1024) {
            issues.push({ severity: 'medium', description: `FCC 仅 ${currentFCC.content.token_count} tokens（需 ≥ 1024）`, fix: '增加 FCC 内容' });
        }

        // 规则3：绿灯条目
        if (charId !== undefined && charId !== null) {
            const char = ctx.characters[charId];
            const book = char?.data?.character_book?.entries;
            if (book) {
                const greenAtBeforeAfter = Object.values(book).filter(e =>
                    e.enabled && !e.constant && (e.position === 1 || e.position === 2)
                );
                if (greenAtBeforeAfter.length > 0) {
                    issues.push({ severity: 'medium', description: `${greenAtBeforeAfter.length} 个绿灯条目在 before/after_char`, fix: '由作者决定位置（§5.2）' });
                }

                const depthEntries = Object.values(book).filter(e =>
                    e.enabled && e.position === 4 && e.depth > 0 && e.depth < 9999
                );
                if (depthEntries.length > 0) {
                    issues.push({ severity: 'high', description: `${depthEntries.length} 个 Dn 深度注入条目`, fix: '考虑移到 D0 或 D9999' });
                }
            }
        }
    } catch (err) {
        issues.push({ severity: 'medium', description: '缓存检测执行异常', fix: '检查连接状态' });
    }

    let score = 100;
    for (const issue of issues) {
        if (issue.severity === 'critical') score -= 30;
        else if (issue.severity === 'high') score -= 15;
        else if (issue.severity === 'medium') score -= 5;
    }
    return { score: Math.max(0, Math.min(100, score)), issues };
}

// ==================== 文本分类 ====================
function classifyText(text) {
    const lower = text.toLowerCase();
    const types = {
        personality: ['性格', '个性', 'personality', '温柔', '冷酷', '傲娇'],
        appearance: ['外貌', '外观', 'appearance', '银发', '长发', '身高'],
        backstory: ['背景', '过去', '历史', 'backstory', '曾经', '小时候'],
        relationship: ['关系', '朋友', '敌人', '恋人', '师徒'],
    };
    let maxScore = 0, maxType = 'default';
    for (const [type, keywords] of Object.entries(types)) {
        const score = keywords.filter(kw => lower.includes(kw)).length;
        if (score > maxScore) { maxScore = score; maxType = type; }
    }
    return maxType;
}

// ==================== Prompt 模板 ====================
const DELETE_FILLER_PROMPT = `你是一个角色卡 token 优化专家。压缩以下角色描述，在不丢失核心人设的前提下最大化减少 token。
1. 删除不影响角色演绎的非核心细节
2. 将散文段落压缩为关键词列表
3. 合并语义重叠的描述
4. 保留定义性的核心特征
5. 输出纯文本，不要添加解释`;

const TYPE_SPECIFIC_PROMPT = {
    personality: `将以下性格描述压缩为最核心的性格关键词。只保留定义角色人设的关键词，去掉所有修饰语。每个关键词不超过4个字。`,
    appearance: `将以下外貌描述压缩为最核心的外貌关键词。只保留最具辨识度的外貌特征，去掉常见描述。`,
    backstory: `将以下背景故事压缩为关键事件和因果。只保留影响角色行为的核心背景，使用"事件→影响"格式。`,
    relationship: `将以下关系描述压缩为关系三元组。格式：(角色A, 关系, 角色B)。`,
    default: `将以下内容压缩为关键信息。去掉所有冗余描述，只保留核心事实。`,
};

const ARCHETYPE_PROMPT = `请先识别角色卡对应的文化原型（如：硬汉侦探、傲娇学妹、温柔御姐...）。然后在 PList 中添加 "- 原型: xxx;" 行。如果角色有偏离原型的设定，添加 "- 偏离原型: xxx;" 行。原型默认行为不需要写出。`;

const SUMMARY_PROMPT = `为以下角色在末尾添加一行总结，格式："- 一句话: [最精炼的角色概括]"。不超过15个字，保留角色的核心矛盾或独特之处。`;

function getFormatPrompt(format, tokenTarget) {
    const prompts = {
        plist: `将以下压缩后的描述转为 PList 格式。\n## 格式要求\n每行格式：\`- 类别: 描述1, 描述2, 描述3;\`\n描述可嵌套：\`- 外貌: 银发, 疤(左眉);\`\n用方括号包裹：\`[- ...;]\`\n## 类别参考\n原型, 龄, 外貌, 性格, 语, 能力, 缺陷, 关系, 背景, 偏离原型\n## 规则\n1. 每个描述不超过4个字 2. 同类用逗号分隔，行末分号 3. 总 token ≤ ${tokenTarget}`,
        concise: `将以下内容转为精简列表格式。每行一个类别，格式：类别: 关键词1, 关键词2。总 token ≤ ${tokenTarget}。`,
        wplus: `将以下内容转为 W+ 简化格式。格式：Category(keyword + keyword)。总 token ≤ ${tokenTarget}。`,
        wplusplus: `将以下内容转为 W++ 格式。格式：[character("名"){Category("keyword" + "keyword")}]。总 token ≤ ${tokenTarget}。`,
    };
    return prompts[format] || prompts.plist;
}

// ==================== 中文 token 税规避 ====================
function applyChineseTokenTaxOpt(text, strategy) {
    const termMap = { '愤世嫉俗': 'cynical', '机器学习': 'ML', '深度学习': 'DL', '人工智能': 'AI', '自然语言': 'NLP', '创伤后应激': 'PTSD', '注意力缺陷': 'ADHD' };
    let result = text;
    for (const [cn, en] of Object.entries(termMap)) {
        if (strategy === 'english_terms') result = result.replace(new RegExp(cn, 'g'), en);
        else if (strategy === 'bilingual') result = result.replace(new RegExp(cn, 'g'), `${cn}(${en})`);
    }
    return result;
}

// ==================== 工具函数 ====================
async function hashText(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return 'sha256:' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}
