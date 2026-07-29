/**
 * 缓存杀手规则定义
 *
 * 5 条规则（来自 token-saving-research.md §1.3）
 * 所有规则都是只读检测，绝不自动修改
 */

export const CACHE_KILLER_RULES = [
    {
        id: 'timestamp_in_system',
        label: '时间戳变量',
        severity: 'critical',
        description: '系统提示含时间戳变量',
        fix: '时间戳放最后或干脆别放',
    },
    {
        id: 'fewshot_order_shuffle',
        label: '示例顺序不固定',
        severity: 'high',
        description: 'few-shot 示例顺序每轮变化',
        fix: '固定 few-shot 示例顺序',
    },
    {
        id: 'dynamic_tool_list',
        label: '工具列表动态变化',
        severity: 'high',
        description: '工具/函数列表在对话中动态变化',
        fix: '工具集稳定后再开会话',
    },
    {
        id: 'config_changed_mid_session',
        label: '会话中修改配置',
        severity: 'high',
        description: '对话中途修改了预设或系统提示',
        fix: '配置好再开会话，要改就开新会话',
    },
    {
        id: 'prefix_too_short',
        label: '前缀过短',
        severity: 'medium',
        description: '稳定前缀 < 1024 tokens',
        fix: '系统提示写够量（>= 1024 token）',
    },
];
