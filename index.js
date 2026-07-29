/**
 * TokenSlim - 角色卡省Token插件
 * 通过 FCC（冻结压缩典籍）实现角色卡文本压缩 + 缓存命中率优化
 *
 * 核心功能：
 * - 将角色卡压缩为 PList 150-token 格式
 * - 自动注入为 before_char 常驻条目（缓存友好）
 * - 三厂商缓存策略路由（Anthropic/OpenAI/DeepSeek）
 * - 缓存杀手检测（只读提示）
 * - Feynman 自检（压缩质量保证）
 * - 增量补丁（append-only，不破坏前缀缓存）
 */

// 第三方扩展路径：/scripts/extensions/third-party/tokenslim/index.js
// 到 script.js（/script.js）需向上 4 层
import {
    eventSource,
    event_types,
    extension_prompt_roles,
    generateQuietPrompt,
    generateRaw,
    setExtensionPrompt,
    saveSettingsDebounced,
    characters,
    this_chid,
} from '../../../../script.js';
// 到 extensions.js（/scripts/extensions.js）需向上 3 层
import { renderExtensionTemplateAsync, extension_settings } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';

import { compressPipeline } from './core/compressor.js';
import { countTokens } from './core/tokenizer.js';
import { generateFCC, loadFCC, saveFCC, clearFCC, hashText } from './fcc/generator.js';
import { injectFCC, removeFCC, ensureFCCInjected, buildInjectionContent } from './fcc/injector.js';
import { appendPatch, foldPatches } from './fcc/patches.js';
import { getCacheStrategy } from './core/cache-router.js';
import { detectCacheKillers } from './cache/detector.js';
import { feynmanSelfCheck } from './core/feynman-check.js';

// ==================== 常量 ====================
const EXT_KEY = 'tokenslim_fcc';       // setExtensionPrompt 的唯一 key
const EXT_NAME = 'tokenslim';          // 扩展名（用于 renderExtensionTemplateAsync 和 extension_settings）
const FCC_POSITION = 1;                // before_char
const FCC_DEPTH = 0;
const FCC_SCAN = false;                 // 不参与 WI 扫描
const FCC_ROLE = extension_prompt_roles.SYSTEM; // 0 = system
const DEFAULT_TOKEN_TARGET = 150;       // PList 150-token 目标
const DEFAULT_FORMAT = 'plist';         // 默认格式

// ==================== 默认设置 ====================
const defaultSettings = {
    enabled: true,
    format: DEFAULT_FORMAT,             // plist | concise | wplus | wplusplus
    tokenTarget: DEFAULT_TOKEN_TARGET,
    archetypeAnchoring: true,           // 原型锚点
    schemaCompression: true,            // Schema 压缩
    feynmanCheck: true,                 // Feynman 自检
    autoInject: true,                   // 自动注入
    chineseTokenTaxOpt: 'off',          // off | english_terms | bilingual
    patchAutoAppend: false,             // 自动追加补丁（默认关闭）
};

// ==================== 扩展状态 ====================
let currentFCC = null;

// ==================== 初始化 ====================
export async function init() {
    console.log('TokenSlim: 初始化...');

    // 初始化设置
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...defaultSettings };
    }
    const settings = extension_settings[EXT_NAME];

    // 渲染设置面板
    const settingsHtml = await renderExtensionTemplateAsync(EXT_NAME, 'settings');
    $('#extensions_settings').append(settingsHtml);

    // 绑定 UI 事件
    bindUIEvents(settings);

    // 监听事件：角色卡加载时注入 FCC
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        if (settings.autoInject) {
            ensureFCCInjected(EXT_KEY, FCC_POSITION, FCC_DEPTH, FCC_SCAN, FCC_ROLE);
        }
    });

    // 监听事件：生成前兜底注入
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => {
        if (settings.autoInject) {
            ensureFCCInjected(EXT_KEY, FCC_POSITION, FCC_DEPTH, FCC_SCAN, FCC_ROLE);
        }
    });

    // 加载当前角色卡的 FCC
    currentFCC = loadFCC();
    if (currentFCC && settings.autoInject) {
        const strategy = getCacheStrategy();
        injectFCC(currentFCC, EXT_KEY, FCC_POSITION, FCC_DEPTH, FCC_SCAN, FCC_ROLE, strategy);
    }

    // 更新 UI 状态
    updateUIState(settings);

    console.log('TokenSlim: 初始化完成');
}

// ==================== UI 事件绑定 ====================
function bindUIEvents(settings) {
    // 启用/禁用
    $('#tokenslim_enabled').on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        if (!settings.enabled) {
            removeFCC(EXT_KEY);
        } else if (currentFCC) {
            const strategy = getCacheStrategy();
            injectFCC(currentFCC, EXT_KEY, FCC_POSITION, FCC_DEPTH, FCC_SCAN, FCC_ROLE, strategy);
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
        // 获取当前角色卡数据（使用 import 的全局变量，而非 getContext）
        const char = characters[this_chid];
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
        let compressedContent = await compressPipeline(allOriginalText, {
            format: settings.format,
            tokenTarget: settings.tokenTarget,
            archetypeAnchoring: settings.archetypeAnchoring,
            schemaCompression: settings.schemaCompression,
            chineseTokenTaxOpt: settings.chineseTokenTaxOpt,
        });

        // Feynman 自检
        let selfCheckResult = null;
        if (settings.feynmanCheck) {
            selfCheckResult = await feynmanSelfCheck(compressedContent, allOriginalText);
            if (selfCheckResult.gaps && selfCheckResult.gaps !== '无关键遗漏') {
                // 追加遗漏的关键信息
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
        saveFCC(currentFCC);

        // 注入 FCC
        const strategy = getCacheStrategy();
        injectFCC(currentFCC, EXT_KEY, FCC_POSITION, FCC_DEPTH, FCC_SCAN, FCC_ROLE, strategy);

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
    removeFCC(EXT_KEY);
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

    appendPatch(currentFCC, {
        trigger_reason: 'user_manual',
        content: content,
    });

    saveFCC(currentFCC);

    // 重新注入
    const strategy = getCacheStrategy();
    injectFCC(currentFCC, EXT_KEY, FCC_POSITION, FCC_DEPTH, FCC_SCAN, FCC_ROLE, strategy);

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
        saveFCC(currentFCC);

        const strategy = getCacheStrategy();
        injectFCC(currentFCC, EXT_KEY, FCC_POSITION, FCC_DEPTH, FCC_SCAN, FCC_ROLE, strategy);

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

    // 显示厂商缓存策略信息
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

    // 基本设置
    $('#tokenslim_enabled').prop('checked', settings.enabled);
    $('#tokenslim_format').val(settings.format);
    $('#tokenslim_token_target').val(settings.tokenTarget);
    $('#tokenslim_archetype').prop('checked', settings.archetypeAnchoring);
    $('#tokenslim_schema').prop('checked', settings.schemaCompression);
    $('#tokenslim_feynman').prop('checked', settings.feynmanCheck);
    $('#tokenslim_auto_inject').prop('checked', settings.autoInject);
    $('#tokenslim_chinese_tax').val(settings.chineseTokenTaxOpt);

    // FCC 状态
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

        // 补丁列表
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
