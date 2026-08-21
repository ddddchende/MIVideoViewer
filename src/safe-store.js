'use strict';

/**
 * 小米账号 token 安全存取
 *
 * 目标：passToken 不再明文写进 go2rtc.yaml，而是加密存储。
 * - Electron 运行时：用 safeStorage（Windows DPAPI / macOS Keychain / Linux）加密
 * - 纯 Node / 无 Electron：安全降级（仅存内存或非持久，绝不写明文文件）
 *
 * go2rtc.yaml 里对应写成占位符 ${XIAOMI_PASS_<userId>}，由 go2rtc 启动时
 * 从环境变量注入替换。进程模块负责在 spawn go2rtc 前解密并设 env。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------- 运行时能力检测 ----------

function isElectron() {
    return !!(process.versions && process.versions.electron);
}

/** Electron 主进程里 safeStorage 是否可用（需 app ready 后） */
function isSafeStorageAvailable() {
    try {
        if (!isElectron()) return false;
        const electron = require('electron');
        if (!electron.safeStorage) return false;
        return electron.safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

/**
 * 加密 store。分成几个独立小模块避免单个 try/catch 全吞。
 */

// ---------- 密码保存：加密文件 ----------

/**
 * 用 Electron safeStorage 加密内容；返回 base64 字符串。
 * 不可用时抛错，由调用方决定是否降级。
 */
function encryptWithSafeStorage(plaintext) {
    const electron = require('electron');
    if (!electron.safeStorage || !electron.safeStorage.isEncryptionAvailable()) {
        throw new Error('safeStorage 不可用');
    }
    return electron.safeStorage.encryptString(plaintext).toString('base64');
}

/** 解密 safeStorage 加密的 base64 内容；失败抛错 */
function decryptWithSafeStorage(encryptedB64) {
    const electron = require('electron');
    if (!electron.safeStorage || !electron.safeStorage.isEncryptionAvailable()) {
        return null;
    }
    const buf = Buffer.from(encryptedB64, 'base64');
    try {
        return electron.safeStorage.decryptString(buf);
    } catch {
        return null;
    }
}

/**
 * token 凭据文件存取
 * 结构：credentials.json  ->  { "userId": "<safeStorage加密的base64>" }
 * 文件路径：dataDir/credentials.json
 */
class CredentialStore {
    constructor({ dataDir }) {
        this.dataDir = dataDir;
        this.filePath = path.join(dataDir, 'credentials.json');
        this._cache = null; // { userId: encryptedB64 }
    }

    async _load() {
        if (this._cache) return this._cache;
        try {
            const raw = await fsp.readFile(this.filePath, 'utf8');
            this._cache = JSON.parse(raw || '{}');
        } catch {
            this._cache = {};
        }
        return this._cache;
    }

    async _persist() {
        await fsp.mkdir(this.dataDir, { recursive: true });
        await fsp.writeFile(this.filePath, JSON.stringify(this._cache, null, 2), 'utf8');
    }

    /**
     * 保存某账号的 token（加密落地）。
     * @returns 'safeStorage' | 'none'  实际用的加密方式（none 表示未存储）
     */
    async save(userId, token) {
        const map = await this._load();
        if (isSafeStorageAvailable()) {
            map[userId] = encryptWithSafeStorage(token);
            await this._persist();
            return 'safeStorage';
        }
        // 无 safeStorage：不落盘明文，也不该落盘。返回 none 由调用方提示。
        console.warn('[safe-store] safeStorage 不可用，token 未持久化加密存储');
        return 'none';
    }

    /**
     * 读取某账号 token（解密）。解密失败返回 null。
     */
    async get(userId) {
        const map = await this._load();
        const enc = map[userId];
        if (!enc) return null;
        if (isSafeStorageAvailable()) {
            return decryptWithSafeStorage(enc);
        }
        return null; // 无法解密
    }

    /** 列出已存储的 userId（不含 token） */
    async listUsers() {
        const map = await this._load();
        return Object.keys(map);
    }

    async remove(userId) {
        const map = await this._load();
        if (!Object.prototype.hasOwnProperty.call(map, userId)) return false;
        delete map[userId];
        await this._persist();
        return true;
    }

    /** 是否已有任意凭据 */
    async hasAny() {
        const map = await this._load();
        return Object.keys(map).length > 0;
    }
}

module.exports = {
    CredentialStore,
    isElectron,
    isSafeStorageAvailable
};
