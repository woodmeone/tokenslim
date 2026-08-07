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

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { hideChatMessageRange } from '../../../chats.js';

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
    retainRecent: 2,          // 每次压缩后保留最近 N 条原文消息（不隐藏）
    autoThreshold: 3,         // 未压缩消息累积达到 N 条时自动触发增量压缩
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
        instruction: `按以下格式输出，每行一个类别，值用逗号分隔。不要写完整句子。
类别1: 值1, 值2, 值3
类别2: 值1, 值2
...只提取聊天中实际出现的信息，禁止编造。`,
    },
    plist: {
        name: 'PList/SBF',
        desc: 'Bullet point结构化，W++进化版，更紧凑',
        example: '[- Name: 艾莉丝;\n - Age: 17;\n - Personality: 温柔, 神秘, 矜持;\n - Appearance: 银发, 翠眼;\n - Secret: 失忆;\n - Events: 初遇→咖啡馆坦白→雨夜冲突→和解;\n]',
        tooltip: 'JanitorAI社区PList格式（W++进化版）。bullet point对LLM更友好，token效率比W++高。分号结尾，描述符用逗号分隔，括号内可嵌套原因。适合需要结构化又想省token的场景。',
        category: '🔧 结构化',
        instruction: `按PList格式输出。每行一个属性，破折号开头，分号结尾。格式：
[- Name: 角色名;
 - 属性: 值1, 值2;
 - Events: 事件1→事件2→事件3;
]
只从聊天中提取真实信息，禁止编造。`,
    },
    eav: {
        name: 'EAV 实体属性值',
        desc: '数据库式：实体.属性=值',
        example: '艾莉丝.年龄=17\n艾莉丝.发色=银\n艾莉丝.关系.用户=恋人\n艾莉丝.秘密=失忆',
        tooltip: '数据库EAV模型（Entity-Attribute-Value）。结构化程度最高，未来可直接导入数据库/表格。例："艾莉丝.关系.用户=恋人"比"艾莉丝和用户现在是恋人关系"省60%。',
        category: '🔧 结构化',
        instruction: `按EAV格式输出。每行一个属性，格式：实体.属性=值。点号分隔层级，等号赋值。禁止写完整句子。只从聊天中提取真实信息，禁止编造。`,
    },
    reaction_rule: {
        name: '反应规则',
        desc: 'WHEN 触发 → 行为反应，极省token',
        example: 'WHEN 被关心 → 先拒绝后感动\nWHEN 被威胁 → 假装不在意\nWHEN 独处 → 暴露脆弱\nWHEN 提及过去 → 回避/沉默',
        tooltip: 'AI行为学方法。只写"触发条件→反应"，AI自动推演完整行为。极省token。例：一条规则"WHEN被关心→先拒绝后感动"替代20条对话记录。',
        category: '🔧 结构化',
        instruction: `按反应规则格式输出。每行一条规则，格式：WHEN 触发条件 → 行为反应。只从聊天中归纳角色实际表现出的反应模式，禁止编造未出现过的规则。`,
    },
    keyword_cloud: {
        name: '关键词云',
        desc: '空格分隔关键词，极致压缩但损语义',
        example: '银发 翠眼 温柔 神秘 失忆 治愈 咖啡馆 雨夜 恋人',
        tooltip: '语义学方法。只保留关键词，AI自行联想上下文。Token效率极高但会丢失语义关系（如"恋人"不知道是谁和谁的）。适合紧急省token场景。',
        category: '🔧 结构化',
        instruction: `只输出空格分隔的关键词，不要任何标点、不要完整句子、不要解释。提取聊天中的关键名词、动词、形容词。禁止编造。`,
    },

    // --- 叙事类方法（保留故事性） ---
    timeline: {
        name: '时间线',
        desc: '按时间节点压缩关键事件',
        example: 'T1: 初遇(公园,闲聊) → T2: 透露秘密(咖啡馆) → T3: 关系转折(雨夜,冲突) → T4: 和解(清晨)',
        tooltip: '历史学方法。按时间顺序压缩为事件节点。每个节点：地点+关键互动。适合有明确剧情推进的对话。',
        category: '📖 叙事',
        instruction: `按时间线格式输出。每行一个时间节点，格式：T序号: 事件(地点,关键互动) → 下一个节点。只记录改变关系/剧情的关键节点，省略寒暄和日常。禁止续写或推测未来事件。`,
    },
    narrative_fold: {
        name: '叙事折叠',
        desc: '按情感/主题打包事件，非线性压缩',
        example: '【失去主题】宠物死亡(童年)+亲人离世(去年)\n【重逢主题】多年后重逢→情感爆发\n【承诺主题】"老地方见"未兑现→冲突根源',
        tooltip: '口述史方法。人脑按情感/主题记忆，不按时间线。"三次失去"压缩为一个模式比三条时间线省得多。适合情感密集的长对话。',
        category: '📖 叙事',
        instruction: `按主题折叠输出。每个主题用【主题名】开头，后面列出相关事件，用+或→连接。把聊天中同类情感/主题的事件打包。禁止续写，禁止添加原文没有的主题。`,
    },
    story_summary: {
        name: '故事摘要',
        desc: '3-5句话概括整个故事',
        example: '用户与艾莉丝初遇于公园。几次深入交谈后，艾莉丝透露了失忆秘密。雨夜冲突后和解，关系升华为恋人。当前：已确立关系，她仍回避过去。',
        tooltip: '叙事学方法。3-5句话概括核心剧情。最接近自然阅读，但压缩比中等。适合想要可读性摘要的用户。',
        category: '📖 叙事',
        instruction: `用3-5句话概括整个对话的核心剧情。每句话必须概括一个关键转折。禁止展开细节，禁止续写，禁止添加原文没有的内容。最后一句用"当前："开头描述当前状态。`,
    },
    dialogue_to_desc: {
        name: '对话→描述',
        desc: '对话体转为叙述体，保留信息减token',
        example: '用户察觉艾莉丝异常并追问。艾莉丝先是回避，在坚持下小声承认想念用户。随后两人约定明天见面。',
        tooltip: 'NEXUSSUM方法。对话体有大量"说话人标记"和动作描写，叙述体把它们融合。800tok对话→200tok描述，信息不减。',
        category: '📖 叙事',
        instruction: `将对话内容转为第三人称叙述体。融合相同话题的对话为一段描述。去掉说话人标记（"用户说"/"艾莉丝说"），改为叙述动作和结果。保留所有关键信息，禁止续写，禁止添加原文没有的内容。`,
    },

    // --- 深度理解方法（保留内在逻辑） ---
    archetype: {
        name: '原型锚点',
        desc: '识别文化原型，只保留偏离部分',
        example: '原型: 傲娇学妹\n(自动推断: 嘴硬心软/脸红/别扭关心)\n偏离: 对猫过敏(非典型)、主动表白(打破模式)\n关键事件: ①承认喜欢猫 ②主动表白',
        tooltip: '文学原型理论。说"傲娇"2字=200字详细描述，原型本身就是压缩。AI自动补全原型默认行为，只需写偏离。Token效率极高。',
        category: '🧠 深度',
        instruction: `按以下格式输出，禁止续写：
原型: [识别角色最接近的文化原型]
(自动推断: [原型默认行为，用/分隔])
偏离: [角色与原型不同的地方，用顿号分隔]
关键事件: ①[偏离事件1] ②[偏离事件2]
只写偏离，原型默认行为不用写。禁止编造偏离。`,
    },
    arc: {
        name: '角色弧光',
        desc: '欲望→障碍→转变，浓缩角色发展',
        example: '欲望: 想被理解但害怕亲密\n障碍: 失忆的秘密阻碍信任\n转变: 雨夜冲突→接受用户的关心→学会信任\n当前: 信任建立中，仍有回避倾向',
        tooltip: '文学创作法（角色弧光）。用"欲望/障碍/转变"三要素浓缩角色发展。比逐条记事件更能保留角色内在逻辑。适合角色有明显成长轨迹的对话。',
        category: '🧠 深度',
        instruction: `按角色弧光格式输出，必须有四个字段：
欲望: [角色内心深处想要什么]
障碍: [什么阻止了角色得到想要的东西]
转变: [事件→事件→事件，按顺序列出改变角色的事件]
当前: [角色现在的状态]
只从聊天中提取，禁止编造或推测。`,
    },
    emotion_stack: {
        name: '情感栈',
        desc: '情感作为压缩原语，用标签代替描述',
        example: '[关心↑2]→[震惊↑1]→[心痛↑3]→[释然↑2]→[深情↑3]\n转折: 心痛↑3=发现被欺骗\n当前: 深情↑3 信任恢复中',
        tooltip: 'BBSE情感编码。情感不是噪声是压缩原语。"心痛→释然→深情"5个字=整个故事弧线。极省token且保留情感脉络。',
        category: '🧠 深度',
        instruction: `按情感栈格式输出：
[情感↑强度]→[情感↑强度]→...
转折: 情感↑N=触发原因
当前: 最终情感↑强度 状态描述
强度1-3，只记录情感变化的关键转折点，禁止编造聊天中没有的情感。`,
    },
    schema: {
        name: '行为模式',
        desc: '压缩为可复用行为模式+偏离',
        example: '模式1: 面对威胁→假装不在意→独处焦虑\n模式2: 收到关心→先拒绝→后感动\n偏离: 第15条消息接受了关心没拒绝(角色成长)',
        tooltip: '认知Schema理论。写一次模式，所有符合该模式的行为不用重复写。只记录偏离模式的新发现。比逐条记事件更省。',
        category: '🧠 深度',
        instruction: `按行为模式格式输出：
模式1: [触发情境]→[行为1]→[行为2]
模式2: [触发情境]→[行为1]→[行为2]
偏离: [不符合上述模式的具体事件](原因)
只归纳聊天中反复出现的行为模式，禁止编造。偏离必须引用具体消息内容。`,
    },

    // --- 关系/结构方法 ---
    relationship: {
        name: '关系图谱',
        desc: '提取角色间关系变化轨迹',
        example: '(用户,艾莉丝): 陌生人→相识→信任→亲密\n关键转折: 咖啡馆透露身世(信任+1), 雨夜冲突(信任-1), 和解(亲密+2)',
        tooltip: '图论方法。格式：(角色A,角色B): 状态轨迹+转折说明。适合多角色、关系复杂的对话。',
        category: '🔗 关系',
        instruction: `按关系图谱格式输出：
(角色A,角色B): 状态1→状态2→...→当前状态
关键转折: 事件(关系变化), 事件(关系变化)
每个关系对一行，转折必须对应具体聊天事件。禁止编造关系变化。`,
    },
    cornell: {
        name: 'Cornell 笔记',
        desc: '关键词+笔记+总结三层结构',
        example: '关键词: 失忆 咖啡馆 雨夜 和解\n笔记: 艾莉丝在咖啡馆首次透露失忆秘密；雨夜因回避问题引发冲突；次日清晨和解\n总结: 从信任危机到关系深化的转折',
        tooltip: '教育学Cornell笔记法。三层：关键词(线索)→笔记(细节)→总结(要点)。比纯摘要更有层次，比W++更可读。适合复杂设定多的对话。',
        category: '🔗 关系',
        instruction: `按Cornell笔记格式输出三层：
关键词: 空格分隔的关键词（5-10个）
笔记: 用分号分隔的要点描述，每条对应一个关键事件
总结: 一句话概括整个对话的核心变化
只从聊天中提取，禁止续写，禁止添加原文没有的信息。`,
    },
    wpp: {
        name: 'W++/JSON',
        desc: '结构化属性格式，通用但符号开销高',
        example: '[character("艾莉丝"){\n  relationship("用户" + "恋人")\n  personality("温柔" + "神秘")\n  secret("失忆")\n  events("初遇" + "咖啡馆坦白" + "雨夜冲突")\n}]',
        tooltip: '通用结构化格式。兼容性好但符号开销高（括号/引号占token）。适合需要与其他工具互通的场景。不推荐作为首选，其他方法更省token。',
        category: '🔗 关系',
        instruction: `按W++格式输出。用中括号包裹角色名，大括号包裹属性，属性值用+连接。格式：
[character("角色名"){
  属性("值1" + "值2")
  events("事件1" + "事件2")
}]
只从聊天中提取，禁止编造。`,
    },
    progressive: {
        name: '渐进摘要（推荐）',
        desc: '事件→关系→情感三层渐进，保留最完整',
        example: '【关键事件】初遇→透露秘密→信任危机→和解\n【关系变化】陌生人→朋友→信任→亲密\n【情感轨迹】好奇→关心→冲突→深情',
        tooltip: '渐进式摘要法（Tiago Forte）。三层渐进：事件→关系→情感。保留最完整上下文，推荐不确定选什么时的默认选项。',
        category: '🔗 关系',
        instruction: `按三层渐进格式输出：
【关键事件】事件1→事件2→事件3→...
【关系变化】状态1→状态2→...→当前状态
【情感轨迹】情感1→情感2→...→当前情感
每层用→连接。关键事件只记改变关系/剧情的节点，关系变化只记转折，情感轨迹只记变化点。禁止续写，禁止添加原文没有的内容。`,
    },
};

// ==================== 初始化 ====================
// 入口：manifest.json 的 hooks.activate 指向本函数（SillyTavern 标准扩展入口）
export async function init() {
    // 防双实例：system + local/global 可能同时加载同名扩展，只初始化一次
    if (window.__tokenslim_initialized) {
        console.warn('TokenSlim: 检测到重复实例，跳过初始化');
        return;
    }
    window.__tokenslim_initialized = true;

    console.log('TokenSlim: 初始化...');

    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...defaultSettings };
    }
    const settings = extension_settings[EXT_NAME];
    if (!settings.charData) settings.charData = {};

    const settingsHtml = await $.get(`${EXT_FOLDER}/settings.html`);
    $('#extensions_settings').append(settingsHtml);

    // 初始化 jQuery UI tooltip（SillyTavern 使用 jQuery UI）
    $('.tokenslim-help').tooltip({
        show: { delay: 300, duration: 200 },
        hide: { delay: 100 },
        position: { my: 'left+10 center', at: 'right center' },
        classes: { 'ui-tooltip': 'tokenslim-tooltip' },
    });

    bindUIEvents(settings);

    const ctx = SillyTavern.getContext();
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        currentFCC = loadFCC();
        if (currentFCC && settings.enabled && settings.autoInject) {
            injectFCC(currentFCC);
            // 恢复已隐藏的消息（页面刷新后 is_system 标记可能丢失，需要重新标记）
            restoreHiddenMessages();
        }
        else if (!settings.autoInject) removeFCC();
        updateUIState(settings);
    });

    ctx.eventSource.on(ctx.eventTypes.GENERATION_AFTER_COMMANDS, (type, generateData, dryRun) => {
        // 关键：过滤 quiet 生成（我们自己的压缩调用）和 dryRun（提示构建），
        // 否则 quiet 生成完成会再次 emit 本事件 → autoIncrementalPatch 自我触发 → 死循环
        if (type === 'quiet' || dryRun) return;
        if (settings.enabled && settings.autoInject) {
            ensureFCCInjected();
            // 自动检测是否需要增量补丁
            autoIncrementalPatch(settings);
        }
    });

    currentFCC = loadFCC();
    if (currentFCC && settings.enabled && settings.autoInject) injectFCC(currentFCC);
    updateUIState(settings);

    console.log('TokenSlim: 初始化完成');
}

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
    const status = ctx.onlineStatus;
    // mainApi 总有默认值（如 koboldhorde），不能作为"已配置"的依据
    if (!api || api === 'undefined' || api === 'no_connection') {
        return { available: false, reason: '请先在 SillyTavern 的 API 设置中配置 AI 连接，TokenSlim 会复用该连接进行压缩。' };
    }
    // online_status === 'no_connection' 表示连接失败/未连接
    if (!status || status === 'no_connection') {
        return { available: false, reason: `当前 AI 连接（${api}）尚未就绪。请先在"API 连接"面板测试连接成功后再压缩。` };
    }
    return { available: true, api, status };
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

    $('#tokenslim_retain_recent').on('input', function () {
        settings.retainRecent = parseInt(String($(this).val())) || 2;
        saveSettingsDebounced();
    });

    $('#tokenslim_auto_threshold').on('input', function () {
        settings.autoThreshold = parseInt(String($(this).val())) || 3;
        saveSettingsDebounced();
    });

    $('#tokenslim_generate_btn').on('click', async () => await handleGenerateFCC(settings));
    $('#tokenslim_rebuild_btn').on('click', async () => await handleGenerateFCC(settings));
    $('#tokenslim_clear_btn').on('click', () => handleClearFCC(settings));
    $('#tokenslim_fold_patches_btn').on('click', async () => await handleFoldPatches(settings));
    $('#tokenslim_cache_check_btn').on('click', () => handleCacheCheck());

    // 复制 FCC 内容
    $('#tokenslim_copy_btn').on('click', () => {
        if (!currentFCC?.content?.raw) return;
        navigator.clipboard.writeText(currentFCC.content.raw).then(() => {
            toastr.success('FCC 内容已复制到剪贴板', 'TokenSlim');
        }).catch(() => {
            // fallback
            const textarea = document.createElement('textarea');
            textarea.value = currentFCC.content.raw;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            toastr.success('FCC 内容已复制', 'TokenSlim');
        });
    });
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

        // 空结果保护：AI 未返回任何内容（未连接 API / 生成失败 / 模型拒绝），立即中止，绝不继续
        if (!compressed || !compressed.trim()) {
            throw new Error('压缩结果为空：AI 未返回任何内容。请确认已在"API 连接"面板配置并测试连接成功，再重试。');
        }

        // 压缩质量验证：如果压缩后超过原文本的80%，视为压缩失败
        let compressedTokens = await countTokens(compressed);
        if (originalTokens > 0 && compressedTokens > originalTokens * 0.8) {
            console.warn('TokenSlim: 压缩比过低，尝试二次压缩', `${compressedTokens}/${originalTokens}`);
            // 二次压缩：用更简单的提示词重试
            const firstPass = compressed;
            compressed = await compressChat(chatText, refContext, settings, true);
            // 二次压缩空结果保护：回退到第一次的结果，绝不生成空 FCC
            if (!compressed || !compressed.trim()) {
                compressed = firstPass;
            }
            compressedTokens = await countTokens(compressed);
        }

        // 如果仍然过长，做硬截断
        if (originalTokens > 0 && compressedTokens > originalTokens * 0.7) {
            console.warn('TokenSlim: 二次压缩仍不理想，提取关键句');
            compressed = extractKeySentences(chatText, settings.tokenTarget || 300);
            compressedTokens = await countTokens(compressed);
        }

        // 可选：Feynman 自检（仅评分，不修改内容！）
        let selfCheckResult = null;
        if (settings.feynmanCheck) {
            selfCheckResult = await feynmanSelfCheck(compressed, chatText, refContext);
            // 自检结果仅用于显示评分，绝不追加到 FCC 内容
        }

        const ratio = originalTokens > 0 ? (compressedTokens / originalTokens) : 0;

        // 记录压缩覆盖的消息范围
        const chat = SillyTavern.getContext().chat || [];
        const coveredMessageCount = chat.filter(m => m.mes && !m.is_system).length;

        currentFCC = {
            fcc_version: 3,
            generated_at: new Date().toISOString(),
            format: settings.format,
            chat_length: chatText.split('\n').filter(l => l.trim()).length,
            covered_messages: coveredMessageCount,
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

        // 隐藏已被 FCC 覆盖的聊天消息（保留最近 retainRecent 条原文）
        await hideCoveredMessages(settings);

        updateUIState(settings);
        updateCompressionResult(originalTokens, compressedTokens, ratio, selfCheckResult);

        const savePercent = Math.round((1 - ratio) * 100);
        if (savePercent < 20) {
            toastr.warning(`压缩效果不佳：${originalTokens} → ${compressedTokens} tok（仅节省 ${savePercent}%）`, 'TokenSlim');
        } else {
            toastr.success(`${originalTokens} → ${compressedTokens} tok（节省 ${savePercent}%）`, 'TokenSlim');
        }
    } catch (err) {
        console.error('TokenSlim: FCC 生成失败', err);
        toastr.error('生成失败：' + err.message, 'TokenSlim');
    } finally {
        btn.html(originalBtnText).prop('disabled', false);
    }
}

// ==================== AI 调用超时保护 ====================
// 给 generateQuietPrompt / getTokenCountAsync 加超时：
// API 连接假死或请求挂起时不会永久卡住界面，超时抛错并降级/中止
async function withTimeout(promise, ms, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s），请检查 API 连接`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// ==================== 核心压缩（单轮高质量压缩） ====================
async function compressChat(chatText, refContext, settings, isRetry = false) {
    const ctx = SillyTavern.getContext();
    const format = FORMAT_OPTIONS[settings.format] || FORMAT_OPTIONS.progressive;
    const targetTokens = settings.tokenTarget || 300;

    // 根据聊天长度选择压缩强度
    const chatLines = chatText.split('\n').filter(l => l.trim()).length;
    const chatTokens = await countTokens(chatText);

    let densityHint = '';
    if (chatTokens < 500) {
        densityHint = '对话较短，保留所有实质内容，只去掉寒暄和纯语气词。';
    } else if (chatTokens < 2000) {
        densityHint = '中等长度，保留所有关键事件和情感变化，去掉寒暄、重复、日常互动。';
    } else {
        densityHint = '长对话，只保留：1)改变关系或剧情的事件 2)角色承诺/约定 3)情感转折点。大幅省略日常互动。';
    }

    // 二次压缩时使用更强硬的提示词
    const retryPrefix = isRetry ? `\n⚠️ 上次压缩失败（输出太长），这次必须更极端地压缩！只保留最关键的信息，大幅删减。` : '';

    const prompt = `# 任务：提取并压缩聊天记录（不是续写！）

你是信息提取引擎，不是故事作者。你的唯一任务是从聊天记录中**提取关键信息**并按指定格式**压缩输出**。
${retryPrefix}
## 绝对禁止（违反任何一条即失败）
- ❌ 禁止续写故事、推测后续发展
- ❌ 禁止添加聊天中未出现的信息
- ❌ 禁止用散文/叙事体展开（除非格式要求）
- ❌ 禁止添加"以下是压缩结果"等前缀
- ❌ 禁止输出任何解释性文字
- ❌ 禁止复制原文（必须改写为压缩格式）

## 角色参考信息（仅供理解，不需要压缩）
${refContext || '（无参考信息）'}

## 待压缩的聊天记录（${chatLines}条消息，约${chatTokens} tokens）
${chatText}

## 压缩强度
${densityHint}

## 输出格式：${format.name}
${format.instruction || format.desc}

参考示例（仅参考格式，内容以实际聊天为准）：
${format.example}

## 压缩要求
1. 目标：约${targetTokens} tokens（宁可少不可多）
2. 必须保留：关键事件、关系变化、情感转折、承诺/约定、角色新发现
3. 必须省略：寒暄、重复内容、纯语气词、无关紧要的细节
4. 遗漏比冗余更严重——但如果原文没有，绝对不能编造
5. 直接输出压缩结果，不要任何前缀、后缀、解释
6. 你的输出必须比原文短很多！如果输出长度接近原文，说明你做错了`;

    try {
        const result = await withTimeout(ctx.generateQuietPrompt({ quietPrompt: prompt }), 60000, '压缩调用');
        return (result || '').trim();
    } catch (err) {
        console.warn('TokenSlim: 压缩失败', err.message || err);
        return '';
    }
}

// ==================== 硬截断：提取关键句 ====================
function extractKeySentences(chatText, targetTokens) {
    // 按行分割，只保留非寒暄的关键行
    const lines = chatText.split('\n').filter(l => l.trim());
    // 粗筛规则：去掉短行（寒暄）、去掉纯语气词
    const keyLines = lines.filter(l => {
        const trimmed = l.trim();
        if (trimmed.length < 10) return false;  // 太短=寒暄
        if (/^[嗯啊哦哈嘿呃]+$/.test(trimmed)) return false;  // 纯语气
        return true;
    });
    // 按目标 token 数截断（粗略：中文2字/tok）
    const maxChars = targetTokens * 2;
    let result = '';
    for (const line of keyLines) {
        if ((result + '\n' + line).length > maxChars) break;
        result += (result ? '\n' : '') + line;
    }
    return result || lines.slice(-5).join('\n');
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

        const result = await withTimeout(ctx.generateQuietPrompt({ quietPrompt: prompt }), 60000, '质量自检');
        const gaps = (result || '').trim();
        // 空结果不评分（避免误导性高分），标记自检未完成
        if (!gaps) {
            return { gaps: '', quality_score: -1, skipped: true };
        }
        const score = gaps.includes('无关键遗漏') || gaps.includes('没有遗漏') ? 95 :
                      gaps.split('\n').filter(l => l.trim()).length <= 1 ? 80 : 50;
        return { gaps, quality_score: score };
    } catch (err) {
        console.warn('TokenSlim: 自检失败', err.message || err);
        return { gaps: '', quality_score: -1, error: err.message };
    }
}

// ==================== 清除/补丁 ====================
function handleClearFCC(settings) {
    // 恢复被隐藏的消息
    if (currentFCC?.hidden_message_indices?.length) {
        unhideCoveredMessages();
    }
    removeFCC();
    currentFCC = null;
    const key = getCharacterKey();
    if (key && settings.charData) {
        delete settings.charData[key];
        saveSettingsDebounced();
    }
    updateUIState(settings);
    toastr.info('FCC 已清除，已恢复隐藏的聊天消息', 'TokenSlim');
}

async function handleFoldPatches(settings) {
    if (!currentFCC?.patches?.length) { toastr.info('没有需要折叠的补丁', 'TokenSlim'); return; }
    try {
        const ctx = SillyTavern.getContext();
        const patchText = currentFCC.patches.map(p => `[补丁${p.seq}] ${p.content}`).join('\n');
        const prompt = `你是信息合并引擎。将以下增量补丁合并进主摘要，输出完整合并后的摘要。

## 当前主摘要
${currentFCC.content.raw}

## 需要合并的增量补丁
${patchText}

输出合并后的完整摘要，把补丁信息融入对应位置。禁止续写，禁止编造。`;

        const folded = await ctx.generateQuietPrompt({ quietPrompt: prompt });
        if (!folded?.trim()) { toastr.warning('合并结果为空', 'TokenSlim'); return; }

        currentFCC.content.raw = folded.trim();
        currentFCC.content.token_count = await countTokens(currentFCC.content.raw);
        currentFCC.patches = [];

        saveFCC(currentFCC);
        if (settings.autoInject) injectFCC(currentFCC);
        updateUIState(settings);
        toastr.success('补丁已折叠合并', 'TokenSlim');
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
    $('#tokenslim_retain_recent').val(settings.retainRecent);
    $('#tokenslim_auto_threshold').val(settings.autoThreshold);

    if (hasFCC) {
        const fmtName = FORMAT_OPTIONS[currentFCC.format]?.name || currentFCC.format || '?';
        const hiddenCount = currentFCC.hidden_message_indices?.length || currentFCC.covered_messages || 0;
        $('#tokenslim_status').html(`<span class="tokenslim-status-active">✅ FCC 已生成 (${fmtName}, 覆盖${hiddenCount}条消息)</span>`);
        $('#tokenslim_rebuild_btn, #tokenslim_clear_btn').show();

        // FCC 面板展示
        $('#tokenslim_fcc_panel').show();
        $('#tokenslim_fcc_content').text(currentFCC.content.raw);
        $('#tokenslim_fcc_meta').html(
            `📄 ${currentFCC.content.original_token_count} → ${currentFCC.content.token_count} tok | ` +
            `节省 ${Math.round((1 - currentFCC.content.compression_ratio) * 100)}% | ` +
            `${(currentFCC.generated_at || '').split('T')[0]}`
        );

        if (currentFCC.patches?.length > 0) {
            $('#tokenslim_patches_list').text(
                currentFCC.patches.map(p => `[补丁${p.seq}] ${p.content}${p.message_count ? ` (${p.message_count}条消息)` : ''}`).join('\n')
            ).show();
            $('#tokenslim_fold_patches_btn').show();
        } else {
            $('#tokenslim_patches_list').hide();
            $('#tokenslim_fold_patches_btn').hide();
        }
    } else {
        $('#tokenslim_status').html('<span class="tokenslim-status-inactive">⬜ FCC 未生成</span>');
        $('#tokenslim_rebuild_btn, #tokenslim_clear_btn').hide();
        $('#tokenslim_fcc_panel').hide();
        $('#tokenslim_patches_list, #tokenslim_fold_patches_btn').hide();
    }

    updateFormatExample();
}

function updateFormatExample() {
    const key = $('#tokenslim_format').val() || 'progressive';
    const fmt = FORMAT_OPTIONS[key];
    if (fmt) {
        // 显示策略说明（来自 tooltip）
        $('#tokenslim_format_desc').html(
            `<span class="tokenslim-format-label">${fmt.category || ''}</span> ${fmt.tooltip || fmt.desc}`
        );
        // 显示格式示例
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
    console.log('TokenSlim: FCC 已保存到 extension_settings', key, `${fcc.content.token_count}tok`);
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
        return await withTimeout(ctx.getTokenCountAsync(text, padding), 10000, 'Token 计数');
    } catch (err) {
        console.warn('TokenSlim: Token 计数失败，使用本地估算', err.message || err);
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

// ==================== 消息隐藏/恢复 ====================
// 利用 SillyTavern 的 hideChatMessageRange API
// 将被 FCC 覆盖的消息标记为 is_system=true，使其不出现在 prompt 中

// 未压缩的可见消息 = 非 system 且未被 tokenslim 隐藏的消息（含上次保留的原文 + 新消息）
function getUncompressedMessages() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    const hidden = new Set(currentFCC?.hidden_message_indices || []);
    const list = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (m.mes && !m.is_system && !hidden.has(i)) list.push({ idx: i, msg: m });
    }
    return list;
}

// 批量隐藏指定消息（标记 is_system=true），并记录索引到 FCC 便于恢复
async function hideMessages(indices) {
    if (!indices?.length) return;
    try {
        const start = indices[0];
        const end = indices[indices.length - 1];
        await hideChatMessageRange(start, end, false);
        if (currentFCC) {
            currentFCC.hidden_message_indices = Array.from(new Set([...(currentFCC.hidden_message_indices || []), ...indices]));
            saveFCC(currentFCC);
        }
        console.log('TokenSlim: 已隐藏消息', start, '→', end, `共${indices.length}条`);
    } catch (err) {
        console.warn('TokenSlim: 隐藏消息失败', err);
    }
}

// 压缩后隐藏：隐藏"未压缩消息中除最近 retainRecent 条外"的所有消息
async function hideCoveredMessages(settings) {
    const retain = Number(settings.retainRecent) || 0;
    const uncompressed = getUncompressedMessages();
    const toHide = uncompressed.slice(0, Math.max(0, uncompressed.length - retain));
    if (toHide.length === 0) return;
    await hideMessages(toHide.map(x => x.idx));
}

// 页面刷新/切换聊天后恢复隐藏标记（仅重新标记 FCC 记录的索引，不新增）
async function restoreHiddenMessages() {
    const indices = currentFCC?.hidden_message_indices;
    if (!indices?.length) return;
    try {
        await hideChatMessageRange(indices[0], indices[indices.length - 1], false);
    } catch (err) {
        console.warn('TokenSlim: 恢复隐藏标记失败', err);
    }
}

function unhideCoveredMessages() {
    try {
        // 用 FCC 记录的隐藏索引精确恢复
        if (currentFCC?.hidden_message_indices?.length > 0) {
            const indices = currentFCC.hidden_message_indices;
            const start = indices[0];
            const end = indices[indices.length - 1];
            hideChatMessageRange(start, end, true);  // true = unhide
            console.log('TokenSlim: 已恢复消息', start, '→', end);
            return;
        }
        // 无索引记录时无法精确恢复，仅提示
        console.warn('TokenSlim: 无 hidden_message_indices 记录，无法恢复隐藏消息');
    } catch (err) {
        console.warn('TokenSlim: 恢复消息失败', err);
    }
}

// ==================== 自动增量检测 ====================
// 当有 FCC 后，检测是否有新的聊天消息需要增量压缩

async function autoIncrementalPatch(settings) {
    if (!currentFCC || !settings.enabled) return;
    // 重入锁：GENERATION_AFTER_COMMANDS 可能被 quiet 生成递归触发，防止并发/递归死循环
    if (window.__tokenslim_patch_running) return;
    window.__tokenslim_patch_running = true;
    try {
    const aiCheck = checkAIAvailable();
    if (!aiCheck.available) return;

    const retain = Number(settings.retainRecent) || 0;
    const threshold = Number(settings.autoThreshold) || 3;

    // 未压缩可见消息 = 上次保留的原文 + 新消息；除最新 retain 条外都待压缩
    const uncompressed = getUncompressedMessages();
    const toCompressCount = uncompressed.length - retain;
    if (toCompressCount < threshold) return;  // 新消息不足阈值，等更多轮次

    const target = uncompressed.slice(0, toCompressCount);
    const targetText = target.map(({ msg }) =>
        `${msg.is_user ? '用户' : (msg.name || '角色')}: ${msg.mes.trim()}`
    ).join('\n');
    if (!targetText.trim()) return;

    const ctx = SillyTavern.getContext();
    const refContext = getReferenceContext(getCurrentCharacterData());
    const format = FORMAT_OPTIONS[settings.format] || FORMAT_OPTIONS.progressive;

    const patchPrompt = `# 任务：增量压缩新增聊天记录

当前已有压缩摘要（FCC），你需要压缩新增的聊天内容，输出一段增量摘要，可以追加到 FCC 后面。

## 现有 FCC 摘要
${currentFCC.content.raw.substring(0, 1000)}

## 新增聊天记录（${target.length}条）
${targetText}

## 输出格式：${format.name}（增量版）
${format.instruction || format.desc}

只压缩新增内容，2-3句话或5-10个要点即可。禁止续写，禁止编造。`;

    try {
        const result = await withTimeout(ctx.generateQuietPrompt({ quietPrompt: patchPrompt }), 60000, '增量压缩');
        const patchContent = (result || '').trim();
        if (!patchContent) return;

        if (!currentFCC.patches) currentFCC.patches = [];
        currentFCC.patches.push({
            seq: currentFCC.patches.length + 1,
            content: patchContent,
            generated_at: new Date().toISOString(),
            message_count: target.length,
        });

        // 隐藏已压缩的消息（保留最近 retain 条原文）
        await hideMessages(target.map(x => x.idx));

        // 更新覆盖消息数
        currentFCC.covered_messages = (currentFCC.covered_messages || 0) + target.length;

        saveFCC(currentFCC);
        if (settings.autoInject) injectFCC(currentFCC);
        updateUIState(settings);

        toastr.success(`增量补丁已生成（${target.length}条新消息）`, 'TokenSlim');
        } catch (err) {
            console.warn('TokenSlim: 增量补丁生成失败', err);
        }
    } finally {
        window.__tokenslim_patch_running = false;
    }
}
