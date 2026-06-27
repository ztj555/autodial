'use strict';
/**
 * UDP 局域网发现模块
 * 
 * 用法:
 *   const discovery = require('./modules/discovery');
 *   const udpSocket = discovery.createDiscoveryService({
 *     DISCOVERY_PORT, PIN_CODE, LOCAL_IP, PORT, fileLog, getLocalIPs
 *   });
 *   discovery.startBroadcast(udpSocket, { PIN_CODE, LOCAL_IP, PORT, DISCOVERY_PORT, getLocalIPs, fileLog });
 */

const dgram = require('dgram');

/**
 * 创建 UDP 发现服务 socket 并绑定
 * @param {object} opts
 * @param {number} opts.DISCOVERY_PORT
 * @param {string} opts.PIN_CODE — 可变（通过 getter 延迟读取）
 * @param {string} opts.LOCAL_IP
 * @param {number} opts.PORT
 * @param {function} opts.fileLog
 * @param {function} opts.getLocalIPs
 * @returns {dgram.Socket}
 */
function createDiscoveryService(opts) {
  const { DISCOVERY_PORT, LOCAL_IP, PORT, fileLog, getLocalIPs } = opts;
  
  const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  udpSocket.on('error', (err) => {
    fileLog && fileLog('E', 'Discovery', null, `UDP错误: ${err.message}`);
  });

  udpSocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      // 延迟读取 PIN_CODE（外部可能尚未设置）
      const currentPin = typeof opts.getPin === 'function' ? opts.getPin() : opts.PIN_CODE;
      if (data.type === 'discover' && data.pin === currentPin) {
        const reply = JSON.stringify({
          type: 'found',
          pin: currentPin,
          ip: LOCAL_IP,
          port: PORT
        });
        udpSocket.send(reply, rinfo.port, rinfo.address);
        fileLog && fileLog('I', 'Discovery', null, `回复发现请求: ${rinfo.address}`);
      }
    } catch (e) {}
  });

  udpSocket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    udpSocket.setBroadcast(true);
    fileLog && fileLog('I', 'Discovery', null, `UDP广播服务已启动, 端口: ${DISCOVERY_PORT}`);
  });

  return udpSocket;
}

/**
 * 启动周期性 UDP 广播（每 10s）
 * @param {dgram.Socket} udpSocket
 * @param {object} opts
 */
function startBroadcast(udpSocket, opts) {
  const { PIN_CODE, LOCAL_IP, PORT, DISCOVERY_PORT, getLocalIPs, fileLog } = opts;

  const msg = JSON.stringify({
    type: 'announce',
    pin: PIN_CODE,
    ip: LOCAL_IP,
    port: PORT
  });

  // 延迟读取：支持外部修改 PIN_CODE
  const buildAnnounceMsg = () => JSON.stringify({
    type: 'announce',
    pin: typeof opts.getPin === 'function' ? opts.getPin() : opts.PIN_CODE,
    ip: LOCAL_IP,
    port: PORT
  });

  const allIps = getLocalIPs ? getLocalIPs() : [];
  fileLog && fileLog('I', 'Discovery', null, `可用IP列表: ${allIps.join(', ')}`);

  const intervalId = setInterval(() => {
    try {
      udpSocket.send(buildAnnounceMsg(), DISCOVERY_PORT, '255.255.255.255');
    } catch (e) {}
  }, 10000);

  return intervalId; // 返回 interval ID 供外部清除
}

module.exports = {
  createDiscoveryService,
  startBroadcast
};
