'use strict';

/**
 * 小米云端 API 客户端（复刻 go2rtc pkg/xiaomi/cloud.go）
 *
 * 用途：登录后用 userId+passToken 换取 ssecurity+serviceToken，
 *       以 MIoT 签名协议调 device_list_page 拉取该账号下的摄像头，
 *       并生成 go2rtc 可用的 streams。
 *
 * 注意：这与 miloco 的 OAuth2+AES 协议不同——go2rtc 走的是经典
 *       passToken + RC4(drop 1024) + sha1 + nonce 签名，必须按 cloud.go 原样复刻，
 *       否则小米云端返回 code!=0。
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');

const SID = 'xiaomiio';
const RESP_PREFIX = '&&&START&&&';
const USER_AGENT = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-QNSUKey/1.0.0.1';
/** 低码率子流名后缀：主流名 + 该后缀 = 标清子流（URL 带 subtype=sd），用于快速预览先出画面 */
const SUB_STREAM_SUFFIX = '_sub';
const REGIONS = {
    de: 'https://de.api.io.mi.com/app',
    i2: 'https://i2.api.io.mi.com/app',
    ru: 'https://ru.api.io.mi.com/app',
    sg: 'https://sg.api.io.mi.com/app',
    us: 'https://us.api.io.mi.com/app'
};
const DEFAULT_BASE_URL = 'https://api.io.mi.com/app';

class XiaomiCloudError extends Error {
    constructor(message, code = 'GENERIC') {
        super(message);
        this.name = 'XiaomiCloudError';
        this.code = code;
    }
}

/** RC4 加密，丢弃前 1024 字节密钥流（对齐 go2rtc crypt） */
function rc4(key, data) {
    const K = Buffer.from(key);
    const D = Buffer.from(data);
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + S[i] + K[i % K.length]) & 255;
        const t = S[i]; S[i] = S[j]; S[j] = t;
    }
    const out = Buffer.alloc(D.length);
    let i = 0; j = 0;
    for (let n = 0; n < 1024 + D.length; n++) {
        i = (i + 1) & 255;
        j = (j + S[i]) & 255;
        const t = S[i]; S[i] = S[j]; S[j] = t;
        if (n >= 1024) {
            out[n - 1024] = D[n - 1024] ^ S[(S[i] + S[j]) & 255];
        }
    }
    return out;
}

/** genSignature64：method&path&<data>&<rc4_hash__>&base64(signedNonce) 的 sha1 */
function genSignature64(method, apiPath, values, signedNonce) {
    let s = `${method}&${apiPath}&data=${values.data}`;
    if (values.rc4_hash__) s += `&rc4_hash__=${values.rc4_hash__}`;
    s += `&${signedNonce}`;
    return crypto.createHash('sha1').update(s).digest('base64');
}

function genNonce() {
    // 12 bytes：前 8 随机，后 4 为大端 unix/60（对齐 go2rtc）
    const nonce = Buffer.alloc(12);
    crypto.randomFillSync(nonce, 0, 8);
    nonce.writeUInt32BE(Math.floor(Date.now() / 1000 / 60), 8);
    return nonce;
}

function getBaseUrl(region) {
    return REGIONS[region] || DEFAULT_BASE_URL;
}

class XiaomiCloud {
    constructor() {
        this.httpTimeoutMs = 15000;
    }

    /** 通用 HTTP 请求；返回 { status, headers, body }，自动跟随有限重定向 */
    _request(method, url, headers = {}, body) {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const lib = u.protocol === 'https:' ? https : http;
            const opts = {
                method,
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                headers: {
                    'User-Agent': USER_AGENT,
                    'accept': '*/*',
                    ...headers
                },
                timeout: this.httpTimeoutMs
            };
            const req = lib.request(opts, res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8')
                }));
            });
            req.on('timeout', () => { req.destroy(); reject(new XiaomiCloudError('请求超时', 'TIMEOUT')); });
            req.on('error', err => reject(new XiaomiCloudError(`网络错误: ${err.message}`, 'NETWORK')));
            if (body) req.write(body);
            req.end();
        });
    }

    /**
     * LoginWithToken：用 userId+passToken 换 ssecurity（加密用）+ serviceToken（cookie 用）
     * 返回 { ssecurity:Buffer, cookies:string }；与 go2rtc Cloud.cookies 一致。
     */
    async loginWithToken(userId, passToken) {
        // 第一步：serviceLogin 用 loginToken 换 ssecurity（body 内）+ location（跳转换取 serviceToken）
        const url = `https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=${SID}`;
        const setCookie = `userId=${userId}; passToken=${passToken}`;
        const login = await this._request('GET', url, { cookie: setCookie });
        let loginBody = login.body;
        if (loginBody.startsWith(RESP_PREFIX)) loginBody = loginBody.slice(RESP_PREFIX.length);
        let loginJson;
        try {
            loginJson = JSON.parse(loginBody);
        } catch {
            throw new XiaomiCloudError('serviceLogin 响应不是合法 JSON', 'BAD_LOGIN_JSON');
        }
        if (loginJson.code !== 0) {
            throw new XiaomiCloudError(`serviceLogin 失败: ${loginJson.description || loginJson.code}`, 'LOGIN_FAIL');
        }
        const ssecurityBuf = loginJson.ssecurity ? Buffer.from(String(loginJson.ssecurity), 'base64') : null;
        const location = loginJson.location;
        if (!ssecurityBuf) {
            throw new XiaomiCloudError('未能从小米服务端获取 ssecurity（token 可能已失效）', 'NO_SSECURITY');
        }

        // 第二步：跟随 location 换 serviceToken cookie（对齐 go2rtc finishAuth）
        // 响应的 Set-Cookie：userId / cUserId / serviceToken；ssecurity 也可能在 Extension-Pragma
        let cUserId = '', serviceToken = '', gotUserId = userId;
        let ssec = ssecurityBuf;
        let target = location;
        let hops = 0;
        while (target && hops < 6) {
            const auth = await this._request('GET', target, { cookie: setCookie });
            const h = auth.headers;
            // 收集 cookies
            (h['set-cookie'] || []).forEach(c => {
                const kv = String(c).split(';')[0].split('=');
                const name = kv[0];
                const val = kv.slice(1).join('=');
                if (name === 'userId') gotUserId = val;
                else if (name === 'cUserId') cUserId = val;
                else if (name === 'serviceToken') serviceToken = val;
                else if (name === 'passToken') { /* 保留 */ }
            });
            // Extension-Pragma 覆盖 ssecurity
            if (h['extension-pragma']) {
                try {
                    const obj = JSON.parse(h['extension-pragma']);
                    if (obj.ssecurity) ssec = Buffer.from(String(obj.ssecurity), 'base64');
                } catch { /* 忽略 */ }
            }
            if (auth.status >= 300 && auth.status < 400 && h.location) {
                target = new URL(h.location, target).toString();
                hops++;
            } else {
                target = null;
            }
        }

        const cookies = `userId=${gotUserId}; cUserId=${cUserId}; serviceToken=${serviceToken}`;
        return { ssecurity: ssec, cookies };
    }

    /**
     * 签名请求 MIoT API。路径如 /v2/home/device_list_page，data 为 JSON 字符串。
     * 完全复刻 go2rtc Cloud.Request。
     */
    async request(region, userId, passToken, apiPath, data, headers) {
        const { ssecurity, cookies } = await this.loginWithToken(userId, passToken);

        // 1) 表单：data（尚未加密的原文）
        let form = { data: data };

        // 2) nonce + signedNonce
        const nonce = genNonce();
        const signedNonce = crypto.createHash('sha256')
            .update(Buffer.concat([ssecurity, nonce]))
            .digest();
        const signedNonceB64 = signedNonce.toString('base64');

        // 3) 对 data 算 rc4_hash__（signature 形式：不带 rc4_hash__ 的串）
        const rc4Hash = genSignature64('POST', apiPath, { data }, signedNonceB64);
        form.rc4_hash__ = rc4Hash;

        // 4) 加密 data 和 rc4_hash__
        const encData = rc4(signedNonce, Buffer.from(form.data, 'utf8')).toString('base64');
        const encHash = rc4(signedNonce, Buffer.from(form.rc4_hash__, 'utf8')).toString('base64');
        form.data = encData;
        form.rc4_hash__ = encHash;

        // 5) 用加密后的 data+rc4_hash__ 算最终 signature
        form.signature = genSignature64('POST', apiPath,
            { data: encData, rc4_hash__: encHash }, signedNonceB64);

        // 6) 追加 nonce
        form._nonce = nonce.toString('base64');

        // 7) POST 发送（x-www-form-urlencoded）
        const body = new URLSearchParams(form).toString();
        const baseUrl = getBaseUrl(region);
        const url = `${baseUrl}${apiPath}`;
        const resp = await this._request('POST', url, {
            cookie: cookies,
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': USER_AGENT,
            ...(headers || {})
        }, body);

        // 8) 响应 body 是 base64(RC4(signedNonce, json))，解密
        let ciphertext;
        try {
            ciphertext = Buffer.from(resp.body.trim(), 'base64');
        } catch {
            throw new XiaomiCloudError('响应不是有效 base64', 'BAD_RESPONSE');
        }
        let plaintext;
        try {
            plaintext = rc4(signedNonce, ciphertext).toString('utf8');
        } catch {
            throw new XiaomiCloudError('响应解密失败', 'DECRYPT');
        }
        let obj;
        try {
            obj = JSON.parse(plaintext);
        } catch {
            throw new XiaomiCloudError('响应不是合法 JSON', 'BAD_JSON');
        }
        if (obj.code !== 0) {
            throw new XiaomiCloudError(`小米云端错误: ${obj.message || obj.code}`, 'CLOUD_CODE');
        }
        return obj.result;
    }

    /**
     * 拉取该账号摄像头列表
     * @returns {Promise<Array<{did,name,model,mac,ip}>>}
     */
    async getCameras(region, userId, passToken) {
        const result = await this.request(region, userId, passToken, '/v2/home/device_list_page', '{}');
        const list = (result && Array.isArray(result) ? result : (result && result.list)) || [];
        return list
            .filter(d => this._hasCamera(d.model))
            .map(d => ({
                did: d.did,
                name: d.name,
                model: d.model,
                mac: d.mac,
                ip: d.localip || d.ip || ''
            }));
    }

    _hasCamera(model) {
        const m = String(model || '');
        return m.includes('.camera.') || m.includes('.cateye.') || m.includes('.feeder.');
    }

    /**
     * 把摄像头写入 go2rtc.yaml 的 streams: 段（新增/更新，保留其它流）
     * 每个摄像头写两条流：
     *   主流「摄像头名」  高清：xiaomi://{userId}:{region}@{ip}?did=...&model=...
     *   子流「名_sub」    标清：同上 + &subtype=sd
     * 子流用于"先出标清画面、后台预热高清再切换"的快速预览（对齐小米官方 App 行为）。
     * 替换规则：按 did + 是否含 subtype= 定位旧行原位替换；没有则追加到 streams 段末尾。
     * @returns {number} 写入的摄像头数量（只算主流）
     */
    async saveStreamsToYaml(yamlPath, region, userId, cameras) {
        await fsp.mkdir(path.dirname(yamlPath), { recursive: true });
        let content = '';
        try { content = await fsp.readFile(yamlPath, 'utf8'); } catch { /* 新文件 */ }
        const lines = content.replace(/\r\n/g, '\n').split('\n');

        // 目标条目：每个 did 生成主流 + 子流两条；重名追加 did 保证唯一
        const seen = new Set();
        const usedNames = new Set();
        const finalEntries = [];
        for (const cam of cameras) {
            if (seen.has(cam.did)) continue;
            seen.add(cam.did);
            let name = sanitizeName(cam.name) || ('cam_' + cam.did);
            if (usedNames.has(name)) name = `${name}_${cam.did}`;
            usedNames.add(name);
            const url = `xiaomi://${userId}:${region}@${cam.ip}?did=${cam.did}&model=${cam.model}`;
            finalEntries.push({ name, url, did: cam.did, sub: false });
            // 子流名同样去重，避免与已有主流名撞名
            let subName = name + SUB_STREAM_SUFFIX;
            if (usedNames.has(subName)) subName = `${name}_${cam.did}${SUB_STREAM_SUFFIX}`;
            usedNames.add(subName);
            finalEntries.push({ name: subName, url: `${url}&subtype=sd`, did: cam.did, sub: true });
        }
        if (!finalEntries.length) return 0;

        // 定位 streams: 顶层键起始行
        let streamsIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (isTopLevelKey(lines[i], 'streams')) { streamsIdx = i; break; }
        }

        // 每个 did 在已有 streams 中的行号：主流（无 subtype=）/子流（含 subtype=）分开定位
        const replaceAtMain = new Map(); // did -> 主流行号
        const replaceAtSub = new Map();  // did -> 子流行号
        if (streamsIdx !== -1) {
            const st = streamsIdx + 1;
            for (let i = st; i < lines.length; i++) {
                if (lines[i].trim() && !isIndentedUnder(lines[i], leadingSpaces(lines[streamsIdx]))) break;
                const m = /did=([0-9A-Za-z_-]+)/.exec(lines[i]);
                if (!m) continue;
                (lines[i].includes('subtype=') ? replaceAtSub : replaceAtMain).set(m[1], i);
            }
        }

        // 逐行重建：streams 段内命中 did 的行原位替换为对应主流/子流，其余原样保留
        const rendered = new Set(); // `${did}:${sub?'1':'0'}`，记录已写入的条目
        const renderEntry = (e) => `  ${quoteKey(e.name)}: ${e.url}`;
        const next = [];
        if (streamsIdx === -1) {
            // 无 streams 段 → 末尾追加
            const block = lines.some(l => l.trim()) ? ['', 'streams:'] : ['streams:'];
            const tail = finalEntries.map(renderEntry);
            next.push(...lines, ...block, ...tail);
        } else {
            for (let i = 0; i < lines.length; i++) {
                if (i <= streamsIdx) { next.push(lines[i]); continue; }
                const line = lines[i];
                if (line.trim() && !isIndentedUnder(line, leadingSpaces(lines[streamsIdx]))) {
                    next.push(...lines.slice(i));
                    break;
                }
                const m = /did=([0-9A-Za-z_-]+)/.exec(line);
                if (m) {
                    const isSub = line.includes('subtype=');
                    const map = isSub ? replaceAtSub : replaceAtMain;
                    if (map.has(m[1])) {
                        const e = finalEntries.find(x => x.did === m[1] && x.sub === isSub);
                        if (e) {
                            next.push(renderEntry(e));
                            rendered.add(`${e.did}:${e.sub ? '1' : '0'}`);
                            continue;
                        }
                    }
                }
                // 未被替换的旧行保留（其它来源的流不受影响）
                next.push(line);
            }
            // 追加新增摄像头（主流 + 子流）
            for (const e of finalEntries) {
                const key = `${e.did}:${e.sub ? '1' : '0'}`;
                if (!rendered.has(key)) {
                    appendIntoStreams(next, leadingSpaces, isIndentedUnder, streamsIdx, renderEntry(e));
                    rendered.add(key);
                }
            }
        }

        let out = next.join('\n').replace(/\n{3,}/g, '\n\n');
        if (!out.endsWith('\n')) out += '\n';
        await fsp.writeFile(yamlPath, out, 'utf8');
        return seen.size;
    }
}

/**
 * 把一行流配置追加到 streams 段内（紧跟在 streams 块最后一个成员后，不越过下一顶层键）
 */
function appendIntoStreams(lines, leadingSpacesFn, isIndentedUnderFn, streamsIdx, lineToAdd) {
    // 找 streams 块结束位置（下一非空且缩进 <= streams 的行）
    const stIndent = streamsIdx < 0 ? 0 : leadingSpacesFn(lines[streamsIdx]);
    let insertAt = lines.length;
    for (let i = streamsIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() && !isIndentedUnderFn(l, stIndent)) { insertAt = i; break; }
    }
    // 若上一个成员行不是空行，先补个空行再追加新成员
    if (insertAt > 0 && lines[insertAt - 1].trim() !== '') {
        lines.splice(insertAt, 0, '', lineToAdd);
    } else {
        lines.splice(insertAt, 0, lineToAdd);
    }
}

// ---------- 现有 xiaomi-qr.js 内部用的行工具（保持风格一致） ----------

function isTopLevelKey(line, key) {
    const t = line.trim();
    return t === key + ':' || t.startsWith(key + ':');
}
function leadingSpaces(line) {
    const m = /^[ \t]*/.exec(line);
    return m ? m[0].length : 0;
}
function isIndentedUnder(line, parentIndent) {
    if (!line.trim()) return false;
    return leadingSpaces(line) > parentIndent;
}
function sanitizeName(name) {
    const s = String(name || '').trim()
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return s;
}
function quoteKey(key) {
    // 数字开头或含特殊字符才加引号，避免 YAML 解析成 number
    return /^\d/.test(key) || /[^\w\u4e00-\u9fa5-]/.test(key) ? `"${key}"` : key;
}

module.exports = { XiaomiCloud, XiaomiCloudError };