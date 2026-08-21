'use strict';

/**
 * 小米账号二维码登录（直接对接 go2rtc）
 *
 * 目标：让用户扫码登录小米账号，把得到的 passToken 写入 go2rtc.yaml，
 * 全程密码不落地、不打开 go2rtc WebUI。
 *
 * 流程（基于 openHAB MiCloudQRConnector 与小米接口反向确认）：
 *   ①  GET /longPolling/loginUrl?sid=xiaomiio...
 *       → 返回 { qr, loginUrl, lp, timeout }；qr 即二维码图片 URL，前端 <img> 直接显示
 *   ②  GET lp（长轮询，阻塞直到扫码/确认/过期）
 *       → 返回 { userId, passToken, ssecurity, location }；userId+passToken 即 go2rtc 所需
 *   ③  写入 go2rtc.yaml 的 xiaomi: 段（仅改这一节，其余配置与注释原样保留）
 *
 * 注意：go2rtc 的 LoginWithToken 只是把 userId+passToken 当 Cookie 发给
 *       account.xiaomi.com/pass/serviceLogin?sid=xiaomiio，与流程②产出零转换对接。
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------- 常量 ----------

const ACCOUNT_HOST = 'account.xiaomi.com';
const LOGIN_PATH = '/longPolling/loginUrl';
// 实测小米接受该 Android UA（见验证步骤 3）
const USER_AGENT = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-QNSUKey/1.0.0.1';
// 与 go2rtc cloud.go 的 AppXiaomiHome 一致（xiaomiio），产物可直接对接
const SID = 'xiaomiio';
/** 小米长轮询响应的 JSONP 前缀，剥掉才是合法 JSON */
const RESP_PREFIX = '&&&START&&&';
const DEFAULT_REGION = 'cn';
// 该账号下区域列表（用于设备列表 API / 摄像头判定，当前登录流程暂未用到）
const REGIONS = ['cn', 'de', 'i2', 'ru', 'sg', 'us'];

const LOGIN_TIMEOUT_MS = 10000; // 建会话超时
// 长轮询上游阻塞时长由小米 control，这里仅作为读响应兜底超时
const POLL_REQUEST_TIMEOUT_MS = 150 * 1000;

class XiaomiQrLoginError extends Error {
    constructor(message, code = 'GENERIC') {
        super(message);
        this.name = 'XiaomiQrLoginError';
        this.code = code;
    }
}

class XiaomiQrLogin {
    constructor({ region = DEFAULT_REGION } = {}) {
        this.region = region;
    }

    // ---------- 对外接口 ----------

    /**
     * ① 创建二维码登录会话
     * @returns {Promise<{sessionId:string, qr:string, loginUrl:string, lp:string, timeoutSec:number}>}
     */
    async startSession() {
        const params = new URLSearchParams({
            _qrsize: '240',
            qs: '%3Fsid%3D' + SID + '%26_json%3Dtrue',
            callback: 'https://sts.api.io.mi.com/sts',
            _hasLogo: 'false',
            sid: SID,
            serviceParam: '',
            _locale: 'zh_CN',
            _dc: String(Date.now())
        });
        const url = `https://${ACCOUNT_HOST}${LOGIN_PATH}?${params.toString()}`;
        const raw = await this._request('GET', url, { timeoutMs: LOGIN_TIMEOUT_MS });
        const data = this._parseJsonResponse(raw);

        const qr = data.qr;
        const loginUrl = data.loginUrl;
        const lp = data.lp;
        const timeoutSec = Number(data.timeout) || 300;
        if (!qr || !lp || !loginUrl) {
            throw new XiaomiQrLoginError('创建二维码会话失败：响应缺少必要字段', 'INVALID_SESSION');
        }
        // 用 lp 里的 ticket 作为会话标识（无需额外状态）
        const sessionId = this._sessionId(lp);
        return { sessionId, qr, loginUrl, lp, timeoutSec };
    }

    /**
     * ② 长轮询等待扫码结果
     * 阻塞直到：扫码确认并返回凭据 / 超时过期 / 主动取消。
     * @param {string} lp 由 startSession 返回的轮询地址
     * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
     * @returns {Promise<{userId:string, passToken:string, ssecurity:string}>}
     */
    async pollForLogin(lp, { signal, timeoutMs } = {}) {
        const deadline = Date.now() + (timeoutMs || POLL_REQUEST_TIMEOUT_MS);
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (signal && signal.aborted) {
                throw new XiaomiQrLoginError('已取消扫码等待', 'CANCELLED');
            }
            if (Date.now() >= deadline) {
                throw new XiaomiQrLoginError('扫码等待超时', 'TIMEOUT');
            }

            // 上游长轮询单次阻塞可达约 120s；这里用串行单发，响应即结果
            const raw = await this._request('GET', lp, { timeoutMs: 125000 }).catch(() => '');
            if (!raw) {
                await this._delay(1000);
                continue;
            }

            let data;
            try {
                data = this._parseJsonResponse(raw);
            } catch {
                await this._delay(1000);
                continue;
            }

            const userId = data.userId;
            const passToken = data.passToken;
            const ssecurity = data.ssecurity;

            if (data.code === 'Expired' || data.code === 'expired' || this._isExpired(data)) {
                throw new XiaomiQrLoginError('二维码已过期，请重新生成', 'EXPIRED');
            }
            if (userId && passToken) {
                return { userId, passToken, ssecurity: ssecurity || '' };
            }
            // 已扫码但尚未确认或仍处于等待态
            await this._delay(2000);
        }
    }

    /**
     * ③ 保存登录凭据：token 加密存储 + go2rtc.yaml 只写占位符
     * go2rtc.yaml 的 xiaomi 段写 ${XIAOMI_PASS_<userId>} 占位符，由 go2rtc-process
     * 启动时从 safe-store 解密注入 env 替换 —— 磁盘上的 yaml 不含明文 token。
     *
     * @param {string} yamlPath go2rtc.yaml 绝对路径
     * @param {string} userId
     * @param {string} passToken 原始 passToken（Qr 响应自带 V1: 前缀）
     * @param {{ store:import('../safe-store').CredentialStore, securityFallback?:boolean }} [opts]
     * @returns {Promise<{stored:boolean, mode:'safeStorage'|'plain'|'none'}>}
     */
    async saveTokenToYaml(yamlPath, userId, passToken, { store, securityFallback = false } = {}) {
        // 1) 优先加密存储 token
        let mode = 'none';
        if (store) {
            mode = await store.save(userId, passToken);
        }
        if (mode === 'none' && !securityFallback) {
            throw new XiaomiQrLoginError(
                '系统安全存储不可用，为避免明文保存凭据已中止。请升级到 Electron 环境或允许使用系统凭据库。',
                'NO_SECURE_STORE');
        }

        // 2) go2rtc.yaml 写占位符（或明文 fallback）
        const yamlValue = (mode === 'safeStorage')
            ? `${'${'}XIAOMI_PASS_${userId}}`
            : passToken;

        await fsp.mkdir(path.dirname(yamlPath), { recursive: true });
        let content;
        try {
            content = await fsp.readFile(yamlPath, 'utf8');
        } catch {
            content = '';
        }
        const next = this._upsertXiaomiSection(content, userId, yamlValue);
        const tmp = `${yamlPath}.tmp`;
        await fsp.writeFile(tmp, next, 'utf8');
        await fsp.rename(tmp, yamlPath);

        return { stored: mode === 'safeStorage', mode };
    }

    async removeAccountFromYaml(yamlPath, userId) {
        let content;
        try {
            content = await fsp.readFile(yamlPath, 'utf8');
        } catch {
            return false;
        }
        const escaped = String(userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const accountPattern = new RegExp(`^\\s*["']?${escaped}["']?\\s*:`);
        const lines = content.replace(/\r\n/g, '\n').split('\n');
        const next = [];
        let inXiaomi = false;
        let xiaomiIndent = 0;
        for (const line of lines) {
            const trimmed = line.trim();
            if (this._isTopLevelKey(line, 'xiaomi')) {
                inXiaomi = true;
                xiaomiIndent = this._leadingSpaces(line);
                next.push(line);
                continue;
            }
            if (inXiaomi && trimmed && this._leadingSpaces(line) <= xiaomiIndent) {
                inXiaomi = false;
            }
            if (inXiaomi && accountPattern.test(line)) continue;
            next.push(line);
        }
        const streams = [];
        let inStreams = false;
        let streamsIndent = 0;
        for (let i = 0; i < next.length; i++) {
            const line = next[i];
            if (this._isTopLevelKey(line, 'streams')) {
                inStreams = true;
                streamsIndent = this._leadingSpaces(line);
                streams.push(line);
                continue;
            }
            if (inStreams && line.trim() && this._leadingSpaces(line) <= streamsIndent) {
                inStreams = false;
            }
            if (inStreams && new RegExp(`xiaomi:\\/\\/${escaped}:`).test(line)) continue;
            streams.push(line);
        }
        const tmp = `${yamlPath}.tmp`;
        await fsp.writeFile(tmp, streams.join('\n'), 'utf8');
        await fsp.rename(tmp, yamlPath);
        return true;
    }

    // ---------- 内部实现 ----------

    _sessionId(lp) {
        // 形如 https://c3.lp.account.xiaomi.com/lp/s?k=lp_xxxx → 用 k 值
        try {
            const u = new URL(lp);
            return u.searchParams.get('k') || lp;
        } catch {
            return lp;
        }
    }

    /** 把响应解码并剥掉 &&&START&&& 前缀后解析为对象 */
    _parseJsonResponse(raw) {
        let text = typeof raw === 'string' ? raw : raw.toString('utf8');
        if (text.startsWith(RESP_PREFIX)) {
            text = text.slice(RESP_PREFIX.length);
        }
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new XiaomiQrLoginError('响应不是合法 JSON', 'BAD_RESPONSE');
        }
    }

    /** 兼容不同错误字段判断二维码过期 */
    _isExpired(data) {
        return data.result === 'FAIL' && /expire|timeout|cancel/i.test(data.desc || '');
    }

    /** 在 yaml 文本中新增或更新 xiaomi: 段，其余内容原样保留 */
    _upsertXiaomiSection(content, userId, passToken) {
        const lines = (content || '').replace(/\r\n/g, '\n').split('\n');

        // 找出 xiaomi: 顶层键的起始行（行首无缩进）
        let xiaomiIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (this._isTopLevelKey(lines[i], 'xiaomi')) {
                xiaomiIdx = i;
                break;
            }
        }

        // 该账号各自嵌套条目（形如   "userId": "passToken"）
        const newEntryLines = this._memberLines(userId, passToken);

        if (xiaomiIdx === -1) {
            // 不存在 xiaomi: → 追加到末尾（保留原有所有行，只追加 xiaomi: 段）
            // 合并后确保以单个换行符结尾
            let body = lines.length ? lines.join('\n').replace(/\n+$/, '') : '';
            if (body && !/:\s*$/.test(body)) {
                // 保证与前面内容至少隔一空行（若最后一非空行不是顶层标段边界，补两个换行）
                body += '\n\n';
            } else {
                body += '\n';
            }
            body += 'xiaomi:\n' + newEntryLines.join('\n') + '\n';
            return body;
        }

        // 存在 → 更新该账号条目；若已存在覆盖，否则追加到 xiaomi 块内
        const xiaomiIndent = this._leadingSpaces(lines[xiaomiIdx]);
        let blockEnd = lines.length;
        for (let i = xiaomiIdx + 1; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed && !this._isIndentedUnder(lines[i], xiaomiIndent)) {
                blockEnd = i; // 下一个顶层键为止
                break;
            }
        }
        const memberPrefix = '  '; // 嵌套成员的常规缩进
        const keyPattern = this._memberKeyRegex(userId);
        const newBlock = [];
        let replaced = false;
        for (let i = xiaomiIdx + 1; i < blockEnd; i++) {
            const line = lines[i];
            if (!this._isIndentedUnder(line, xiaomiIndent)) {
                newBlock.push(line);
                continue;
            }
            const trimmed = line.trim();
            if (trimmed && keyPattern.test(trimmed)) {
                // 用写入时的缩进对齐原块成员
                newBlock.push(memberPrefix + this._memberKeyQuote(userId) + ': ' + this._quoteToken(passToken));
                replaced = true;
            } else {
                newBlock.push(line);
            }
        }
        if (!replaced) {
            // 块末尾补成员：先清掉旧块内末尾空行，避免成员间出现多余空行
            while (newBlock.length && !newBlock[newBlock.length - 1].trim()) {
                newBlock.pop();
            }
            newBlock.push(...newEntryLines);
        }

        const before = lines.slice(0, xiaomiIdx + 1);
        const after = lines.slice(blockEnd);
        return [...before, ...newBlock, ...after].join('\n');
    }

    /** 嵌套成员行，统一以两个空格缩进写入 */
    _memberLines(userId, passToken) {
        return [`  ${this._memberKeyQuote(userId)}: ${this._quoteToken(passToken)}`];
    }

    _memberKeyQuote(userId) {
        // 统一加引号，避免纯数字被 YAML 解析成 number 导致 key 失配
        return `"${String(userId).replace(/"/g, '\\"')}"`;
    }

    _quoteToken(passToken) {
        const s = String(passToken);
        return `"${s.replace(/"/g, '\\"')}"`;
    }

    /** 匹配形如  "userId":  或  userId:  的成员行的正则（值部分忽略） */
    _memberKeyRegex(userId) {
        const esc = String(userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`^[\\s-]*"?${esc}"?\\s*:`);
    }

    _isTopLevelKey(line, key) {
        const trimmed = line.trim();
        return trimmed === key + ':' || trimmed.startsWith(key + ':'); // 允许同一行内联
    }

    _leadingSpaces(line) {
        const m = /^[ \t]*/.exec(line);
        return m ? m[0].length : 0;
    }

    /** 该行缩进是否 > 父键缩进（即属于 xiaomi: 块内成员） */
    _isIndentedUnder(line, parentIndent) {
        if (!line.trim()) return false; // 空行不归属
        const indent = this._leadingSpaces(line);
        return indent > parentIndent;
    }

    _delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    /** 发起 HTTPS GET 请求，返回 body 字符串 */
    _request(method, url, { timeoutMs = 10000, redirects = 5 } = {}) {
        return new Promise((resolve, reject) => {
            let current = url;
            const go = (target, depth) => {
                const u = new URL(target);
                const isHttps = u.protocol === 'https:';
                const lib = isHttps ? https : http;
                const req = lib.request(target, {
                    method,
                    headers: {
                        'User-Agent': USER_AGENT,
                        Accept: '*/*'
                    },
                    timeout: timeoutMs
                }, res => {
                    // 处理重定向（小米 EU/海外区可能重定向到 c3.account.xiaomi.com）
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        if (depth < redirects) {
                            go(new URL(res.headers.location, target).toString(), depth + 1);
                        } else {
                            reject(new XiaomiQrLoginError('重定向次数过多', 'REDIRECT'));
                        }
                        return;
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        reject(new XiaomiQrLoginError(`请求失败 HTTP ${res.statusCode}`, 'HTTP_STATUS'));
                        return;
                    }
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                });
                req.on('timeout', () => { req.destroy(); });
                req.on('error', err => {
                    reject(new XiaomiQrLoginError(`网络错误: ${err.message}`, 'NETWORK'));
                });
                req.end();
            };
            go(current, redirects);
        });
    }
}

module.exports = { XiaomiQrLogin, XiaomiQrLoginError };
