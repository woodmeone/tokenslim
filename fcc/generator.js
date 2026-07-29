/**
 * FCC（冻结压缩典籍）生成器
 *
 * 负责 FCC 的保存、加载、清除、哈希
 * FCC 数据存储在角色卡的 extensions.tokenslim.fcc 中
 */

import { characters, this_chid } from '../../../../../script.js';
import { saveMetadataDebounced } from '../../../../extensions.js';

/**
 * 加载当前角色卡的 FCC
 * @returns {object|null} FCC 数据，不存在则返回 null
 */
export function loadFCC() {
    try {
        const char = characters?.[this_chid];
        if (!char?.data?.extensions?.tokenslim?.fcc) {
            return null;
        }
        return char.data.extensions.tokenslim.fcc;
    } catch (err) {
        console.warn('TokenSlim: FCC 加载失败', err);
        return null;
    }
}

/**
 * 保存 FCC 到当前角色卡
 * @param {object} fcc - FCC 数据
 */
export function saveFCC(fcc) {
    try {
        const char = characters?.[this_chid];
        if (!char?.data) {
            console.warn('TokenSlim: 无法保存 FCC，角色卡未加载');
            return;
        }

        if (!char.data.extensions) {
            char.data.extensions = {};
        }
        if (!char.data.extensions.tokenslim) {
            char.data.extensions.tokenslim = {};
        }

        char.data.extensions.tokenslim.fcc = fcc;

        // 保存角色卡元数据（包含 extensions 字段）
        saveMetadataDebounced();
        console.log('TokenSlim: FCC 已保存');
    } catch (err) {
        console.error('TokenSlim: FCC 保存失败', err);
    }
}

/**
 * 清除当前角色卡的 FCC
 */
export function clearFCC() {
    try {
        const char = characters?.[this_chid];
        if (char?.data?.extensions?.tokenslim) {
            delete char.data.extensions.tokenslim.fcc;
            saveMetadataDebounced();
        }
    } catch (err) {
        console.error('TokenSlim: FCC 清除失败', err);
    }
}

/**
 * 计算文本哈希（SHA-256 前16位）
 * @param {string} text - 待哈希的文本
 * @returns {Promise<string>} 哈希值
 */
export async function hashText(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return 'sha256:' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}
