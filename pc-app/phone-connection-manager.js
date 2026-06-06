/**
 * AutoDial PhoneConnectionManager v6
 * 单机对单机架构：PIN 标识，独立状态机，连接数硬限制
 * 支持 LAN + Cloud 双通道，云端强制重连
 * 预留文件上传协议处理桩方法
 */

const path = require('path');
const fs = require('fs');

// ==================== v6 日志系统（独立，不依赖 main.js） ====================
const LOG_DIR = (() => {
    try {
        const { app } = require('electron');
        return path.join(app.getPath('userData'), 'autodial-logs');
    } catch (_) {
        return path.join(process.env.APPDATA || '.', 'autodial-pc', 'autodial-logs');
    }
})();
const MAX_LOG_SIZE = 10 * 1024 * 1024;  // 10MB 单文件上限
const MAX_LOG_DAYS = 7;
const LOG_FALLBACK_BUFFER = [];          // 内存降级环形缓冲区
const LOG_FALLBACK_MAX = 1000;
let _logFailCount = 0;

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function _getLogFile() {
    const dateStr = new Date().toISOString().slice(0, 10);
    return path.join(LOG_DIR, `autodial-pc-${dateStr}.log`);
}

function _v6Log(level, module, pin, msg) {
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
    const pinStr = pin ? `[${pin}]` : '[----]';
    const line = `${ts} [${level}] [${module}] ${pinStr} ${msg}\n`;
    try {
        const logFile = _getLogFile();
        const stat = fs.existsSync(logFile) ? fs.statSync(logFile) : { size: 0 };
        if (stat.size >= MAX_LOG_SIZE) {
            // 滚动：创建 .1 文件
            const extIdx = logFile.lastIndexOf('.log');
            const altFile = logFile.slice(0, extIdx) + '.1' + logFile.slice(extIdx);
            try { fs.renameSync(logFile, altFile); } catch (_) {}
        }
        fs.appendFileSync(logFile, line, 'utf8');
        _logFailCount = 0;
    } catch (_) {
        _logFailCount++;
        if (_logFailCount >= 3) {
            // 降级为内存日志
            LOG_FALLBACK_BUFFER.push(line);
            if (LOG_FALLBACK_BUFFER.length > LOG_FALLBACK_MAX) LOG_FALLBACK_BUFFER.shift();
        }
    }
}

function v6LogInfo(module, pin, msg) { _v6Log('I', module, pin, msg); }
function v6LogWarn(module, pin, msg) { _v6Log('W', module, pin, msg); }
function v6LogError(module, pin, msg) { _v6Log('E', module, pin, msg); }
function v6LogDebug(module, pin, msg) { /* 仅开发环境开启 */ }

function v6LogMessage(direction, pin, msgType, content) {
    const truncated = content.length > 500 ? content.substring(0, 500) + '...(truncated)' : content;
    _v6Log('I', direction, pin, `[${msgType}] ${truncated}`);
}

// 启动时清理过期日志
function _cleanOldLogs() {
    try {
        const files = fs.readdirSync(LOG_DIR);
        const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
        for (const file of files) {
            if (file.endsWith('.log')) {
                const filePath = path.join(LOG_DIR, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
                } catch (_) {}
            }
        }
    } catch (_) {}
}
_cleanOldLogs();

// ==================== 常量与配置 ====================
const CONNECTION_STATES = Object.freeze({
    DISCONNECTED: 'DISCONNECTED',
    DISCOVERING: 'DISCOVERING',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED'
});

const MAX_PHONE_CONNECTIONS = 2;    // 最多 2 个对端
const CLOUD_CONNECTION_COUNT = 1;  // 1 个云端中继
const HEARTBEAT_TIMEOUT = 45000;    // 45 秒心跳超时
const HEARTBEAT_INTERVAL = 30000;   // 30 秒心跳间隔
const NEIGHBOR_TTL = 30000;         // 邻居表 TTL 30s
const ACK_TIMEOUT = 3000;           // ACK 超时 3s

// ==================== ReconnectScheduler ====================
class ReconnectScheduler {
    constructor(onReconnect) {
        this._onReconnect = onReconnect;
        this._attempts = 0;
        this._timer = null;
        this._paused = false;
    }

    /** 触发重连（如已有定时器则在当前轮次完成后重新调度） */
    trigger(reason) {
        if (this._paused) return;
        this._cancel();
        const delay = this._getDelay();
        this._timer = setTimeout(() => {
            if (!this._paused) {
                this._attempts++;
                if (this._onReconnect) this._onReconnect(this._attempts, reason);
            }
        }, delay);
    }

    /** 连接成功 / 用户手动 / 网络变化 → 立即重置 */
    reset(reason) {
        this._cancel();
        this._attempts = 0;
        this.trigger(reason);
    }

    /** 达到最大次数后停止，需要手动触发 */
    pause() { this._paused = true; this._cancel(); }
    resume(reason) { this._paused = false; this.trigger(reason); }

    cancel() { this._cancel(); }
    get attempts() { return this._attempts; }
    get isPaused() { return this._paused; }

    _getDelay() {
        const n = this._attempts + 1;
        if (n === 1)        return 0;       // 立即
        if (n === 2)        return 1000;    // 1s
        if (n === 3)        return 3000;    // 3s
        if (n <= 6)         return 5000;    // 4-6: 5s
        if (n <= 10)        return 10000;   // 7-10: 10s
        if (n <= 15)        return 30000;   // 11-15: 30s
        if (n <= 20)        return 60000;   // 16-20: 60s
        return 300000;                       // 21+: 5分钟
    }

    _cancel() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }
}

// ==================== PhoneConnectionManager ====================
const PhoneConnectionManager = {
    // --- 设备表：remotePin → device ---
    devices: new Map(),
    activePin: null,
    MAX_CONNECTIONS: MAX_PHONE_CONNECTIONS,

    // ACK 机制
    ACK_TIMEOUT,
    _pendingAcks: new Map(),
    _msgIdCounter: 0,

    // v6: 拨号待发队列 — 手机不在线时暂存，连上后自动补发
    _dialQueue: new Map(),   // pin → { number, timer, resolve }
    DIAL_QUEUE_TIMEOUT: 30000, // 30 秒超时

    // 外部回调
    onUpdate: null,         // (devices, activePin)
    onConnectionEvent: null, // (type, pin, data) // connected/disconnected/statechange

    // --- 日志辅助 ---
    _logI(pin, msg) { v6LogInfo('ConnMgr', pin, msg); },
    _logW(pin, msg) { v6LogWarn('ConnMgr', pin, msg); },
    _logE(pin, msg) { v6LogError('ConnMgr', pin, msg); },

    /**
     * 注册/更新设备
     * @param {string} pin - 对端 PIN（4位）
     * @param {Object} info - { name, ip, ws?, cloudWs?, isCloud?, alias? }
     * @returns {string|null} 成功返回 pin，失败返回 null（如超限）
     */
    registerDevice(pin, info) {
        // v6: 建连前清理僵尸连接，stale 设备不计入有效连接数
        // 规范 2.3 + 3.4
        // 先清理超时 stale 设备（TTL 过期 + 无活跃通道）
        this._purgeDeadZombies();

        const activeCount = Array.from(this.devices.values()).filter(d => !d.stale).length;

        // 连接数硬限制（仅对非 stale 的新设备）
        if (activeCount >= this.MAX_CONNECTIONS && !this.devices.has(pin)) {
            this._logW(pin, `注册拒绝：已达连接上限(有效=${activeCount}, 上限=${this.MAX_CONNECTIONS})`);
            return null;
        }

        let device = this.devices.get(pin);

        if (device) {
            // 更新已有设备
            if (info.ws) device.ws = info.ws;
            if (info.cloudWs) device.cloudWs = info.cloudWs;
            if (info.isCloud !== undefined) device.isCloud = info.isCloud;
            if (info.name) device.name = info.name;
            if (info.ip) device.ip = info.ip;
            if (info.alias) device.alias = info.alias;
            device.lastHeartbeat = Date.now();
            device.state = CONNECTION_STATES.CONNECTED;
            device.stale = false;

            // 重置重连调度器
            if (device.reconnectScheduler) device.reconnectScheduler.cancel();

            this._logI(pin, `设备已更新: name=${device.name} ip=${device.ip} lan=${!!device.ws} cloud=${!!device.cloudWs}`);
        } else {
            // 新设备
            device = {
                pin,
                name: info.name || 'Unknown',
                ip: info.ip || (info.isCloud ? 'cloud' : ''),
                alias: info.alias || '',
                ws: info.ws || null,
                cloudWs: info.cloudWs || null,
                isCloud: info.isCloud || false,
                state: CONNECTION_STATES.CONNECTED,
                stale: false,
                lastHeartbeat: Date.now(),
                connectedAt: Date.now(),
                reconnectScheduler: null  // 手机端自己管理重连，PC 端仅在云端唤醒时创建
            };
            this.devices.set(pin, device);
            this._logI(pin, `新设备注册: name=${device.name} ip=${device.ip} lan=${!!device.ws} cloud=${!!device.cloudWs}`);
        }

        // 自动选为活跃设备
        if (!this.activePin || !this.devices.has(this.activePin)) {
            this.activePin = pin;
            this._logI(pin, `自动设为活跃设备`);
        }

        this._notifyUpdate();
        return pin;
    },

    /**
     * 移除设备或通道
     * @param {string} pin
     * @param {string} transport - 'lan' | 'cloud' | 'all'
     */
    removeDevice(pin, transport) {
        const device = this.devices.get(pin);
        if (!device) return;

        if (transport === 'lan') {
            device.ws = null;
            device.lastHeartbeat = 0;
            device.stale = true;
            this._logW(pin, `LAN 通道已断开, 标记 stale`);
            if (device.cloudWs) {
                device.state = CONNECTION_STATES.CONNECTED;
            } else {
                device.state = CONNECTION_STATES.DISCONNECTED;
            }
        } else if (transport === 'cloud') {
            device.cloudWs = null;
            device.isCloud = false;
            device.stale = true;
            this._logW(pin, `云端通道已断开, 标记 stale`);
            if (device.ws) {
                device.state = CONNECTION_STATES.CONNECTED;
            } else {
                device.state = CONNECTION_STATES.DISCONNECTED;
            }
        } else {
            // 全部移除
            this.devices.delete(pin);
            this._logI(pin, `设备已完全移除`);
            // v6 规范8.3: 禁止掉线自动切换，保持 activePin 为 null 等待用户手动选择
            if (this.activePin === pin) {
                this.activePin = null;
                this._logI(pin, '活跃设备已移除，等待用户手动选择');
            }
        }

        // 清理 stale 设备的待处理 ACK
        if (device.stale) {
            this._cleanupPendingAcks(pin);
        }

        this._notifyUpdate();
    },

    /**
     * 标记设备为 stale（网络变化时）
     */
    markStale(pin) {
        const device = this.devices.get(pin);
        if (!device) return;
        device.stale = true;
        this._logW(pin, '标记为 stale（网络变化）');
        this._notifyUpdate();
    },

    /**
     * 向设备发送消息，LAN 优先
     * @param {string} pin
     * @param {Object} msg
     * @returns {boolean}
     */
    sendToPhone(pin, msg) {
        const device = this.devices.get(pin);
        if (!device) {
            this._logE(pin, `sendToPhone 失败: 设备不存在`);
            return false;
        }

        // LAN 优先
        if (device.ws && device.ws.readyState === 1) {
            try {
                device.ws.send(JSON.stringify(msg));
                v6LogMessage('SEND-LAN', pin, msg.type || '?', JSON.stringify(msg));
                return true;
            } catch (e) {
                this._logW(pin, `LAN 发送失败: ${e.message}`);
                device.ws = null;
            }
        }

        // Cloud 降级
        if (device.cloudWs && device.cloudWs.readyState === 1) {
            try {
                const payload = Object.assign({}, msg, { targetDevice: device.name });
                device.cloudWs.send(JSON.stringify(payload));
                v6LogMessage('SEND-CLOUD', pin, msg.type || '?', JSON.stringify(payload));
                return true;
            } catch (e) {
                this._logW(pin, `Cloud 发送失败: ${e.message}`);
            }
        }

        this._logW(pin, `sendToPhone 完全失败: type=${msg.type || '?'}`);
        return false;
    },

    /**
     * 带 ACK 确认的发送（用于关键消息 dial/hangup/sms）
     */
    sendToPhoneWithAck(pin, msg, timeout) {
        timeout = timeout || this.ACK_TIMEOUT;
        const device = this.devices.get(pin);
        if (!device) return Promise.resolve(false);

        const messageId = 'ack_' + Date.now() + '_' + (++this._msgIdCounter);
        const msgWithId = Object.assign({}, msg, { messageId });

        return new Promise((resolve) => {
            const entry = {
                pin, msg: msgWithId, resolve,
                channel: 'unknown', retried: false, timer: null
            };

            entry.timer = setTimeout(() => {
                if (!entry.retried) {
                    entry.retried = true;
                    this._logW(pin, `ACK 超时 type=${msg.type} id=${messageId}, 尝试备选通道重试 (原通道=${entry.channel})`);
                    const retryOk = this._sendOnAltChannel(pin, msgWithId, entry.channel);
                    if (retryOk) {
                        entry.timer = setTimeout(() => {
                            this._pendingAcks.delete(messageId);
                            this._logE(pin, `ACK 重试超时 type=${msg.type} id=${messageId}`);
                            resolve(false);
                        }, timeout);
                    } else {
                        this._pendingAcks.delete(messageId);
                        this._logE(pin, `ACK 重试失败, 无备选通道 type=${msg.type}`);
                        resolve(false);
                    }
                } else {
                    this._pendingAcks.delete(messageId);
                    this._logE(pin, `ACK 最终超时 type=${msg.type} id=${messageId}`);
                    resolve(false);
                }
            }, timeout);

            this._pendingAcks.set(messageId, entry);

            const sent = this._sendWithChannelTracking(pin, msgWithId, entry);
            if (!sent) {
                clearTimeout(entry.timer);
                this._pendingAcks.delete(messageId);
                resolve(false);
            }
        });
    },

    _sendWithChannelTracking(pin, msg, entry) {
        const device = this.devices.get(pin);
        if (!device) return false;

        if (device.ws && device.ws.readyState === 1) {
            try {
                device.ws.send(JSON.stringify(msg));
                entry.channel = 'lan';
                v6LogMessage('SEND-LAN', pin, msg.type || '?', JSON.stringify(msg));
                return true;
            } catch (e) {
                this._logW(pin, `_sendWithChannelTracking LAN 失败: ${e.message}`);
                device.ws = null;
            }
        }

        if (device.cloudWs && device.cloudWs.readyState === 1) {
            try {
                const payload = Object.assign({}, msg, { targetDevice: device.name });
                device.cloudWs.send(JSON.stringify(payload));
                entry.channel = 'cloud';
                v6LogMessage('SEND-CLOUD', pin, msg.type || '?', JSON.stringify(payload));
                return true;
            } catch (e) {
                this._logW(pin, `_sendWithChannelTracking Cloud 失败: ${e.message}`);
            }
        }

        return false;
    },

    _sendOnAltChannel(pin, msg, usedChannel) {
        const device = this.devices.get(pin);
        if (!device) return false;

        if (usedChannel === 'lan') {
            if (device.cloudWs && device.cloudWs.readyState === 1) {
                try {
                    const payload = Object.assign({}, msg, { targetDevice: device.name });
                    device.cloudWs.send(JSON.stringify(payload));
                    return true;
                } catch (_) {}
            }
        } else if (usedChannel === 'cloud') {
            if (device.ws && device.ws.readyState === 1) {
                try { device.ws.send(JSON.stringify(msg)); return true; } catch (_) {}
            }
        }
        return false;
    },

    /**
     * 处理手机端回的 ACK
     */
    handleAck(msg) {
        if (!msg || !msg.messageId) return;
        const entry = this._pendingAcks.get(msg.messageId);
        if (entry) {
            clearTimeout(entry.timer);
            this._pendingAcks.delete(msg.messageId);
            this._logI(entry.pin, `ACK 确认 type=${msg.originalType || '?'} id=${msg.messageId}`);
            entry.resolve(true);
        }
    },

    _cleanupPendingAcks(pin) {
        for (const [msgId, entry] of this._pendingAcks) {
            if (entry.pin === pin) {
                clearTimeout(entry.timer);
                this._pendingAcks.delete(msgId);
                entry.resolve(false);
            }
        }
    },

    // --- 活跃设备 ---

    getActiveDevice() {
        if (!this.activePin) return null;
        const device = this.devices.get(this.activePin);
        if (!device) return null;
        const lanOk = device.ws && device.ws.readyState === 1;
        const cloudOk = device.isCloud && device.cloudWs && device.cloudWs.readyState === 1;
        if (!lanOk && !cloudOk) return null;
        return { pin: this.activePin, ...device };
    },

    getDeviceList() {
        const list = [];
        this.devices.forEach((device, pin) => {
            const lanOk = device.ws && device.ws.readyState === 1;
            const cloudOk = device.isCloud && device.cloudWs && device.cloudWs.readyState === 1;
            let connType = 'none';
            let status = 'offline';
            if (device.stale) {
                status = 'offline';
            } else if (lanOk && cloudOk) {
                connType = 'lan+cloud'; status = 'online';
            } else if (lanOk) {
                connType = 'lan'; status = 'online';
            } else if (cloudOk) {
                connType = 'cloud'; status = 'online';
            } else if (device.state === CONNECTION_STATES.CONNECTING) {
                status = 'connecting';
            }

            // UI 显示规则：优先别名，兜底 "设备类型+末4位PIN"
            const displayName = device.alias || device.name || ('设备' + pin.slice(-4));

            list.push({
                id: pin,          // 向后兼容：HTML 使用 phone.id
                pin,
                name: displayName,
                note: device.alias, // 向后兼容：旧 UI 使用 note 字段
                rawName: device.name,
                alias: device.alias,
                ip: device.ip,
                active: pin === this.activePin,
                connectedAt: device.connectedAt,
                isCloud: cloudOk,
                connectionType: connType,
                status,
                stale: device.stale
            });
        });
        return list;
    },

    setActiveDevice(pin) {
        if (!this.devices.has(pin)) return;
        this.activePin = pin;
        const device = this.devices.get(pin);
        this._logI(pin, `设为活跃设备: ${device.alias || device.name}`);
        this._notifyUpdate();
    },

    /**
     * v6: 手机不在线时暂存拨号请求，连上后自动补发
     * @returns {Promise<boolean>} true=已立即发送, false=已排队等待
     */
    queueDial(pin, number, onQueued) {
        const device = this.devices.get(pin);
        const lanOk = device && device.ws && device.ws.readyState === 1;
        const cloudOk = device && device.isCloud && device.cloudWs && device.cloudWs.readyState === 1;

        if (lanOk || cloudOk) {
            // 手机在线，直接发送（不走队列）
            return this.sendToPhoneWithAck(pin, { type: 'dial', number });
        }

        // 手机不在线 → 加入队列
        this._cancelDialQueue(pin);
        this._logI(pin, `手机不在线，拨号 ${number} 进入待发队列(${this.DIAL_QUEUE_TIMEOUT / 1000}s超时)`);

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this._dialQueue.delete(pin);
                this._logW(pin, `待发拨号 ${number} 已超时`);
                resolve(false);
            }, this.DIAL_QUEUE_TIMEOUT);

            this._dialQueue.set(pin, { number, timer, resolve });
            if (typeof onQueued === 'function') onQueued();
        });
    },

    /**
     * v6: 手机连接成功后，检查并补发待发拨号
     * @returns {boolean} 是否有待发拨号被补发
     */
    flushDialQueue(pin) {
        const entry = this._dialQueue.get(pin);
        if (!entry) return false;

        this._logI(pin, `补发待发拨号: ${entry.number}`);
        clearTimeout(entry.timer);
        this._dialQueue.delete(pin);

        // 发送并等待 ACK
        this.sendToPhoneWithAck(pin, { type: 'dial', number: entry.number }).then(acked => {
            entry.resolve(acked);
        });
        return true;
    },

    /** 检查某 PIN 是否有待发拨号 */
    hasQueuedDial(pin) {
        return this._dialQueue.has(pin);
    },

    _cancelDialQueue(pin) {
        const entry = this._dialQueue.get(pin);
        if (entry) {
            clearTimeout(entry.timer);
            entry.resolve(false);
            this._dialQueue.delete(pin);
        }
    },

    /**
     * 通过云端中继发送强制重连指令
     * @param {string} pin - 目标手机 PIN
     * @param {WebSocket} cloudWs - 云端 WebSocket
     */
    sendForceReconnectViaCloud(pin, cloudWs) {
        if (!cloudWs || cloudWs.readyState !== 1) {
            this._logE(pin, '强制重连失败: 云端未连接');
            return false;
        }
        try {
            cloudWs.send(JSON.stringify({
                type: 'reconnect_request',
                targetDevice: pin  // v6: 与云端 relay 的 targetDevice 字段名一致
            }));
            this._logI(pin, '已发送强制重连指令 via 云端');
            return true;
        } catch (e) {
            this._logE(pin, `发送强制重连指令失败: ${e.message}`);
            return false;
        }
    },

    // --- 心跳 ---

    updateHeartbeat(pin) {
        const device = this.devices.get(pin);
        if (device) {
            device.lastHeartbeat = Date.now();
            device.stale = false;
        }
    },

    /** 通过设备名称更新心跳（云端连接场景） */
    updateHeartbeatByName(deviceName) {
        for (const [pin, device] of this.devices) {
            if (device.name === deviceName) {
                device.lastHeartbeat = Date.now();
                device.stale = false;
                return pin;
            }
        }
        return null;
    },

    /** 定期检查心跳超时 */
    checkHeartbeats() {
        const now = Date.now();
        const toRemove = [];
        this.devices.forEach((device, pin) => {
            if (device.lastHeartbeat > 0 && (now - device.lastHeartbeat) > HEARTBEAT_TIMEOUT) {
                this._logW(pin, `心跳超时(${Math.round((now - device.lastHeartbeat)/1000)}s), 标记断开`);
                toRemove.push(pin);
            }
        });
        toRemove.forEach(pin => this.removeDevice(pin, 'all'));
    },

    /** 清理超时 stale 设备（邻居表 TTL） */
    cleanupStaleDevices() {
        const now = Date.now();
        this.devices.forEach((device, pin) => {
            if (device.stale && device.lastHeartbeat > 0 &&
                (now - device.lastHeartbeat) > NEIGHBOR_TTL) {
                this._logI(pin, 'stale 设备 TTL 超时，移除');
                this.devices.delete(pin);
                // v6 规范8.3: 禁止自动切换
                if (this.activePin === pin) this.activePin = null;
            }
        });
        this._notifyUpdate();
    },

    // --- 上传协议桩方法 ---

    onFileUploadStart(pin, msg) {
        this._logI(pin, `[UPLOAD-STUB] file_upload_start: ${msg.fileName} size=${msg.fileSize}`);
    },
    onFileChunk(pin, msg) {
        this._logI(pin, `[UPLOAD-STUB] file_chunk: uploadId=${msg.uploadId} idx=${msg.chunkIndex}`);
    },
    onFileUploadComplete(pin, msg) {
        this._logI(pin, `[UPLOAD-STUB] file_upload_complete: ${msg.fileName} hash=${msg.fileHash}`);
    },
    onFileUploadError(pin, msg) {
        this._logE(pin, `[UPLOAD-STUB] file_upload_error: ${msg.errorCode} ${msg.message}`);
    },

    // --- 内部 ---

    _selectFirst() {
        const first = this.devices.keys().next();
        this.activePin = first.done ? null : first.value;
    },

    /** v6: 清理僵尸设备（stale 且已超过 TTL，无任何活跃通道） */
    _purgeDeadZombies() {
        const now = Date.now();
        for (const [pin, device] of this.devices) {
            if (device.stale && !device.ws && !device.cloudWs &&
                (now - device.lastHeartbeat) > NEIGHBOR_TTL) {
                this._logI(pin, '清理僵尸设备（stale + TTL过期 + 无通道）');
                this.devices.delete(pin);
                if (this.activePin === pin) this.activePin = null; // v6: 不自动切换
            }
        }
    },

    _notifyUpdate() {
        if (typeof PhoneConnectionManager.onUpdate === 'function') PhoneConnectionManager.onUpdate();
        if (typeof global._notifyPhonesUpdate === 'function') global._notifyPhonesUpdate();
    }
};

// 向后兼容别名
PhoneConnectionManager.phones = PhoneConnectionManager.devices;
PhoneConnectionManager.activePhoneId = null; // 由 main.js 同步
PhoneConnectionManager.generateUUID = function(name) { return name; }; // v6 不再需要 UUID

module.exports = PhoneConnectionManager;
