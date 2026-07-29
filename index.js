/**
 * TokenSlim - 聊天记录省Token插件
 * 
 * 核心思路（基于 token-saving-research.md）：
 * 1. 角色卡+世界书不压缩（保持原样作为稳定前缀 → 缓存命中）
 * 2. 只压缩聊天记录（动态内容 → 减少冗余）
 * 3. FCC 注入到 IN_CHAT 位置（世界书之后，聊天记录之前）
 * 
 * 压缩策略参考：
 * - 渐进式摘要（Progressive Summarization）：多次小压缩 > 一次大压缩
 * - 原型锚点（Archetype）：用文化原型压缩默认行为
 * - Schema理论：压缩为行为模式而非逐字记录
 * - 四层记忆模型：固定层(角色卡) / 热数据(最近消息) / 温数据(早期消息压缩) / 冷数据(不注入)
 */

import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

// ==================== 常量 ====================
const EXT_KEY = 'tokenslim_fcc';
const EXT_NAME = 'tokenslim';
const EXT_FOLDER = `scripts/extensions/third-party/${EXT_NAME}`;

// 注入位置：IN_CHAT = 1（在世界书/角色卡之后，聊天记录区域）
const FCC_POSITION = 1;  // extension_prompt_types.IN_CHAT
const FCC_DEPTH = 9999;  // 深度9999 = 放在聊天记录区域最前面
const FCC_SCAN = false;
const FCC_ROLE = 0;      // extension_prompt_roles.SYSTEM

// ==================== 默认设置 ====================
const defaultSettings = {
    enabled: true,
    format: 'progressive',    // 压缩策略
    tokenTarget: 300,
    feynmanCheck: true,
    autoInject: true,
    charData: {},
};

// ==================== 扩展状态 ====================
let currentFCC = null;

// ==================== 压缩策略定义 ====================
// 整合自：plugin-dev-spec.md 10种方法 + token-saving-research.md 跨学科调研
const FORMAT_OPTIONS = {
    // --- 高效率结构化方法（省token最多） ---
    compact_list: {
        name: '精简列表',
        desc: '属性值直接列出，用逗号分隔，最简洁',
        example: '外貌: 银发, 翠眼, 纤细\n性格: 温柔, 神秘, 矜持\n能力: 治愈术, 共情',
        tooltip: '规格领域方法。将属性值直接用逗号列出，不加修饰。Token效率极高。例："银发翠眼纤细"比"她有一头银色的长发，翠绿的眼睛，身材纤细"省80%。',
        category: '🔧 结构化',
    },
    eav: {
        name: 'EAV 实体属性值',
        desc: '数据库式：实体.属性=值',
        example: '艾莉丝.年龄=17\n艾莉丝.发色=银\n艾莉丝.关系.用户=恋人\n艾莉丝.秘密=失忆',
        tooltip: '数据库EAV模型（Entity-Attribute-Value）。结构化程度最高，未来可直接导入数据库/表格。例："艾莉丝.关系.用户=恋人"比"艾莉丝和用户现在是恋人关系"省60%。',
        category: '🔧 结构化',
    },
    reaction_rule: {
        name: '反应规则',
        desc: 'WHEN 触发 → 行为反应，极省token',
        example: 'WHEN 被关心 → 先拒绝后感动\nWHEN 被威胁 → 假装不在意\nWHEN 独处 → 暴露脆弱\nWHEN 提及过去 → 回避/沉默',
        tooltip: 'AI行为学方法。只写"触发条件→反应"，AI自动推演完整行为。极省token。例：一条规则"WHEN被关心→先拒绝后感动"替代20条对话记录。',
        category: '🔧 结构化',
    },
    keyword_cloud: {
        name: '关键词云',
        desc: '空格分隔关键词，极致压缩但损语义',
        example: '银发 翠眼 温柔 神秘 失忆 治愈 咖啡馆 雨夜 恋人',
        tooltip: '语义学方法。只保留关键词，AI自行联想上下文。Token效率极高但会丢失语义关系（如"恋人"不知道是谁和谁的）。适合紧急省token场景。',
        category: '🔧 结构化',
    },

    // --- 叙事类方法（保留故事性） ---
    timeline: {
        name: '时间线',
        desc: '按时间节点压缩关键事件',
        example: 'T1: 初遇(公园,闲聊) → T2: 透露秘密(咖啡馆) → T3: 关系转折(雨夜,冲突) → T4: 和解(清晨)',
        tooltip: '历史学方法。按时间顺序压缩为事件节点。每个节点：地点+关键互动。适合有明确剧情推进的对话。',
        category: '📖 叙事',
    },
    narrative_fold: {
        name: '叙事折叠',
        desc: '按情感/主题打包事件，非线性压缩',
        example: '【失去主题】宠物死亡(童年)+亲人离世(去年)\n【重逢主题】多年后重逢→情感爆发\n【承诺主题】"老地方见"未兑现→冲突根源',
        tooltip: '口述史方法。人脑按情感/主题记忆，不按时间线。"三次失去"压缩为一个模式比三条时间线省得多。适合情感密集的长对话。',
        category: '📖 叙事',
    },
    story_summary: {
        name: '故事摘要',
        desc: '3-5句话概括整个故事',
        example: '用户与艾莉丝初遇于公园。几次深入交谈后，艾莉丝透露了失忆秘密。雨夜冲突后和解，关系升华为恋人。当前：已确立关系，她仍回避过去。',
        tooltip: '叙事学方法。3-5句话概括核心剧情。最接近自然阅读，但压缩比中等。适合想要可读性摘要的用户。',
        category: '📖 叙事',
    },
    dialogue_to_desc: {
        name: '对话→描述',
        desc: '对话体转为叙述体，保留信息减token',
        example: '用户察觉艾莉丝异常并追问。艾莉丝先是回避，在坚持下小声承认想念用户。随后两人约定明天见面。',
        tooltip: 'NEXUSSUM方法。对话体有大量"说话人标记"和动作描写，叙述体把它们融合。800tok对话→200tok描述，信息不减。',
        category: '📖 叙事',
    },

    // --- 深度理解方法（保留内在逻辑） ---
    archetype: {
        name: '原型锚点',
        desc: '识别文化原型，只保留偏离部分',
        example: '原型: 傲娇学妹\n(自动推断: 嘴硬心软/脸红/别扭关心)\n偏离: 对猫过敏(非典型)、主动表白(打破模式)\n关键事件: ①承认喜欢猫 ②主动表白',
        tooltip: '文学原型理论。说"傲娇"2字=200字详细描述，原型本身就是压缩。AI自动补全原型默认行为，只需写偏离。Token效率极高。',
        category: '🧠 深度',
    },
    arc: {
        name: '角色弧光',
        desc: '欲望→障碍→转变，浓缩角色发展',
        example: '欲望: 想被理解但害怕亲密\n障碍: 失忆的秘密阻碍信任\n转变: 雨夜冲突→接受用户的关心→学会信任\n当前: 信任建立中，仍有回避倾向',
        tooltip: '文学创作法（角色弧光）。用"欲望/障碍/转变"三要素浓缩角色发展。比逐条记事件更能保留角色内在逻辑。适合角色有明显成长轨迹的对话。',
        category: '🧠 深度',
    },
    emotion_stack: {
        name: '情感栈',
        desc: '情感作为压缩原语，用标签代替描述',
        example: '[关心↑2]→[震惊↑1]→[心痛↑3]→[释然↑2]→[深情↑3]\n转折: 心痛↑3=发现被欺骗\n当前: 深情↑3 信任恢复中',
        tooltip: 'BBSE情感编码。情感不是噪声是压缩原语。"心痛→释然→深情"5个字=整个故事弧线。极省token且保留情感脉络。',
        category: '🧠 深度',
    },
    schema: {
        name: '行为模式',
        desc: '压缩为可复用行为模式+偏离',
        example: '模式1: 面对威胁→假装不在意→独处焦虑\n模式2: 收到关心→先拒绝→后感动\n偏离: 第15条消息接受了关心没拒绝(角色成长)',
        tooltip: '认知Schema理论。写一次模式，所有符合该模式的行为不用重复写。只记录偏离模式的新发现。比逐条记事件更省。',
        category: '🧠 深度',
    },

    // --- 关系/结构方法 ---
    relationship: {
        name: '关系图谱',
        desc: '提取角色间关系变化轨迹',
        example: '(用户,艾莉丝): 陌生人→相识→信任→亲密\n关键转折: 咖啡馆透露身世(信任+1), 雨夜冲突(信任-1), 和解(亲密+2)',
        tooltip: '图论方法。格式：(角色A,角色B): 状态轨迹+转折说明。适合多角色、关系复杂的对话。',
        category: '🔗 关系',
    },
    cornell: {
        name: 'Cornell 笔记',
        desc: '关键词+笔记+总结三层结构',
        example: '关键词: 失忆 咖啡馆 雨夜 和解\n笔记: 艾莉丝在咖啡馆首次透露失忆秘密；雨夜因回避问题引发冲突；次日清晨和解\n总结: 从信任危机到关系深化的转折',
        tooltip: '教育学Cornell笔记法。三层：关键词(线索)→笔记(细节)→总结(要点)。比纯摘要更有层次，比W++更可读。适合复杂设定多的对话。',
        category: '🔗 关系',
    },
    wpp: {
        name: 'W++/JSON',
        desc: '结构化属性格式，通用但符号开销高',
        example: '[character("艾莉丝"){\n  relationship("用户" + "恋人")\n  personality("温柔" + "神秘")\n  secret("失忆")\n  events("初遇" + "咖啡馆坦白" + "雨夜冲突")\n}]',
        tooltip: '通用结构化格式。兼容性好但符号开销高（括号/引号占token）。适合需要与其他工具互通的场景。不推荐作为首选，其他方法更省token。',
        category: '🔗 关系',
    },
    progressive: {
        name: '渐进摘要',
        desc: '事件→关系→情感三层渐进，保留最完整',
        example: '【关键事件】初遇→透露秘密→信任危机→和解\n【关系变化】陌生人→朋友→信任→亲密\n【情感轨迹】好奇→关心→冲突→深情',
        tooltip: '渐进式摘要法（Tiago Forte）。三层渐进：事件→关系→情感。保留最完整上下文，推荐不确定选什么时的默认选项。',
        category: '🔗 关系',
    },
};

// ==================== 初始化 ====================
jQuery(async () => {
    console.log('TokenSlim: 初始化...');

    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...defaultSettings };
    }
    const settings = extension_settings[EXT_NAME];
    if (!settings.charData) settings.charData = {};

    const settingsHtml = await $.get(`${EXT_FOLDER}/settings.html`);
    $('#extensions_settings').append(settingsHtml);

    bindUIEvents(settings);

    const ctx = SillyTavern.getContext();
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        if (settings.autoInject || true) {
            currentFCC = loadFCC();
            if (currentFCC && settings.enabled && settings.autoInject) injectFCC(currentFCC);
            else if (!settings.autoInject) removeFCC();
            updateUIState(settings);
        }
    });

    ctx.eventSource.on(ctx.eventTypes.GENERATION_AFTER_COMMANDS, () => {
        if (settings.enabled && settings.autoInject) ensureFCCInjected();
    });

    currentFCC = loadFCC();
    if (currentFCC && settings.enabled && settings.autoInject) injectFCC(currentFCC);
    updateUIState(settings);

    console.log('TokenSlim: 初始化完成');
});

// ==================== 获取当前角色 ====================
function getCharacterKey() {
    const charData = getCurrentCharacterData();
    return charData?.char?.avatar || null;
}

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

function checkAIAvailable() {
    const ctx = SillyTavern.getContext();
    const api = ctx.mainApi;
    if (!api || api === 'undefined') {
        return { available: false, reason: '请先在 SillyTavern 的 API 设置中配置 AI 连接，TokenSlim 会复用该连接进行压缩。' };
    }
    return { available: true, api };
}

// ==================== 文本收集 ====================
// 参考上下文：角色卡+世界书（不压缩，给AI理解用）
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
        .map(m => `${m.is_user ? '用户' : (m.name || '角色')}: ${m.mes.trim()}`)
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

        const fmtName = FORMAT_OPTIONS[settings.format]?.name || settings.format;
        toastr.info(`聊天 ${originalTokens}tok | 策略: ${fmtName}`, 'TokenSlim 开始压缩');

        // 核心压缩
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
            fcc_version: 3,
            generated_at: new Date().toISOString(),
            format: settings.format,
            chat_length: chatText.split('\n').filter(l => l.trim()).length,
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

        toastr.success(`${originalTokens} → ${compressedTokens} tok（节省 ${Math.round((1 - ratio) * 100)}%）`, 'TokenSlim');
    } catch (err) {
        console.error('TokenSlim: FCC 生成失败', err);
        toastr.error('生成失败：' + err.message, 'TokenSlim');
    } finally {
        btn.html(originalBtnText).prop('disabled', false);
    }
}

// ==================== 核心压缩（单轮高质量压缩） ====================
async function compressChat(chatText, refContext, settings) {
    const ctx = SillyTavern.getContext();
    const format = FORMAT_OPTIONS[settings.format] || FORMAT_OPTIONS.progressive;
    const targetTokens = settings.tokenTarget || 300;

    // 根据聊天长度选择策略
    const chatLines = chatText.split('\n').filter(l => l.trim()).length;
    const chatTokens = await countTokens(chatText);

    let compressionStrategy = '';
    if (chatTokens < 500) {
        compressionStrategy = '对话较短，几乎不需要压缩，只去掉重复和寒暄即可。';
    } else if (chatTokens < 2000) {
        compressionStrategy = '中等长度对话，保留所有关键事件和情感变化，去掉寒暄和重复。';
    } else {
        compressionStrategy = '长对话，重点保留：1)改变关系或剧情的事件 2)角色做出的承诺/约定 3)情感转折点。可以大幅省略日常互动。';
    }

    const prompt = `你是一个专业的故事摘要师，正在压缩一段AI角色扮演的聊天记录。

## 参考信息（角色的身份和设定，不需要压缩，仅供理解）
${refContext || '（无参考信息）'}

## 待压缩的聊天记录（${chatLines}条消息，${chatTokens} tokens）
${chatText}

## 压缩策略
${compressionStrategy}

## 输出格式：${format.name}
${format.desc}
参考示例：${format.example}

## 压缩要求
1. 目标：约${targetTokens} tokens
2. 宁可保留关键信息也不要遗漏——遗漏比冗余更严重
3. 必须保留：关键事件、关系变化、情感转折、承诺/约定、角色新发现
4. 可以省略：寒暄、重复内容、无关紧要的细节
5. 不要添加原文中没有的信息
6. 直接输出压缩结果，不要任何前缀或解释`;

    try {
        const result = await ctx.generateQuietPrompt({ quietPrompt: prompt });
        return (result || chatText).trim();
    } catch (err) {
        console.warn('TokenSlim: 压缩失败，返回末尾片段', err);
        const lines = chatText.split('\n');
        return lines.slice(-Math.ceil(lines.length / 3)).join('\n');
    }
}

// ==================== Feynman 自检 ====================
async function feynmanSelfCheck(compressed, originalChat, refContext) {
    try {
        const ctx = SillyTavern.getContext();
        const prompt = `你是质量检查员。对比聊天原文和压缩结果，检查是否有对后续角色扮演有影响的关键信息被遗漏。

## 参考设定
${(refContext || '无').substring(0, 1000)}

## 聊天原文（截取）
${originalChat.substring(0, 3000)}

## 压缩结果
${compressed}

如果压缩结果已包含所有关键信息，回复"无关键遗漏"。
否则，用一句话列出遗漏的关键信息（如"遗漏了：角色承诺明天见面"）。`;

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

// ==================== 清除/补丁 ====================
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
        const prompt = `将以下增量更新压缩为最精炼的摘要，保留所有关键变化。\n\n${patchText}\n\n压缩结果：`;
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
        toastr.error('折叠失败', 'TokenSlim');
    }
}

// ==================== 缓存健康度 ====================
function handleCacheCheck() {
    const result = detectCacheKillers();
    const panel = $('#tokenslim_cache_result');
    panel.empty();

    const cls = result.score >= 80 ? 'tokenslim-cache-good' : result.score >= 50 ? 'tokenslim-cache-warn' : 'tokenslim-cache-bad';
    const icon = result.score >= 80 ? '✓' : result.score >= 50 ? '⚠' : '✗';
    panel.append(`<div class="${cls}">缓存健康度: ${result.score}/100 ${icon}</div>`);

    for (const issue of result.issues) {
        const i = issue.severity === 'critical' ? '🔴' : issue.severity === 'high' ? '🟡' : '🟢';
        panel.append(`<div class="tokenslim-cache-issue">${i} ${issue.description} → ${issue.fix}</div>`);
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
        const fmtName = FORMAT_OPTIONS[currentFCC.format]?.name || currentFCC.format || '?';
        $('#tokenslim_status').html(`<span class="tokenslim-status-active">✅ FCC 已生成 (${fmtName}, ${currentFCC.chat_length || '?'}条消息)</span>`);
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
    const key = $('#tokenslim_format').val() || 'progressive';
    const fmt = FORMAT_OPTIONS[key];
    if (fmt) {
        const label = fmt.category ? `${fmt.category} · ` : '';
        $('#tokenslim_format_example').html(
            `<span style="opacity:0.6;font-style:normal">${label}${fmt.desc}</span>\n${fmt.example}`
        );
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

// ==================== FCC 存储 ====================
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
        // 注入到 IN_CHAT 位置，depth=9999 放在聊天记录最前面（世界书之后）
        ctx.setExtensionPrompt(EXT_KEY, content, FCC_POSITION, FCC_DEPTH, FCC_SCAN, FCC_ROLE);
        console.log('TokenSlim: FCC 已注入', { position: FCC_POSITION, depth: FCC_DEPTH, tokenCount: fcc.content?.token_count });
    } catch (err) {
        console.error('TokenSlim: FCC 注入失败', err);
    }
}

function removeFCC() {
    try {
        const ctx = SillyTavern.getContext();
        ctx.setExtensionPrompt(EXT_KEY, '', FCC_POSITION, FCC_DEPTH, FCC_SCAN, FCC_ROLE);
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
            issues.push({ severity: 'medium', description: `FCC 仅 ${currentFCC.content.token_count} tok（≥1024 更利缓存）`, fix: '增大 token 目标' });
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
        issues.push({ severity: 'medium', description: '缓存检测异常', fix: '检查连接状态' });
    }

    let score = 100;
    for (const issue of issues) {
        score -= issue.severity === 'critical' ? 30 : issue.severity === 'high' ? 15 : 5;
    }
    return { score: Math.max(0, Math.min(100, score)), issues };
}
