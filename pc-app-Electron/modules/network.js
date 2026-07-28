'use strict';
/**
 * 网络工具模块
 * 
 * 用法:
 *   const network = require('./modules/network');
 *   console.log(network.LOCAL_IP, network.PORT);
 *   network.PIN_CODE = '13800138000';  // 可写
 */

const os = require('os');

// ==================== 常量 ====================
const PORT = 35432;
const DISCOVERY_PORT = 35433;

// 多网络适配器过滤关键词
const ADAPTER_EXCLUDE_KEYWORDS = ['virtual', 'vmware', 'docker', 'hyper', 'bluetooth', 'loopback', 'nodebabylink'];
const ADAPTER_ETHERNET_KEYWORDS = ['eth', 'en', '以太', 'ethernet', 'pci'];
const ADAPTER_WIFI_KEYWORDS = ['wlan', 'wl', '无线', 'wifi'];

// ==================== 可变状态（允许外部修改） ====================
let PIN_CODE = '';  // v4: 初始为空，需手动设置11位手机号

// ==================== 工具函数 ====================

function generatePinCode() {
  return '';
}

function getMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac;
      }
    }
  }
  return os.hostname();
}

/** 获取所有可用网络接口 */
function getAllUsableInterfaces() {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const name of Object.keys(interfaces)) {
    const lower = name.toLowerCase();
    if (ADAPTER_EXCLUDE_KEYWORDS.some(k => lower.includes(k))) continue;
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        result.push({ name, address: iface.address, adapterName: name.toLowerCase() });
      }
    }
  }
  // 优先级排序：有线 > WiFi > 其他
  result.sort((a, b) => {
    const aEth = ADAPTER_ETHERNET_KEYWORDS.some(k => a.adapterName.includes(k)) ? 0 : 1;
    const aWifi = ADAPTER_WIFI_KEYWORDS.some(k => a.adapterName.includes(k)) ? 1 : 2;
    const bEth = ADAPTER_ETHERNET_KEYWORDS.some(k => b.adapterName.includes(k)) ? 0 : 1;
    const bWifi = ADAPTER_WIFI_KEYWORDS.some(k => b.adapterName.includes(k)) ? 1 : 2;
    const aRank = Math.min(aEth, aWifi);
    const bRank = Math.min(bEth, bWifi);
    if (aRank !== bRank) return aRank - bRank;
    return a.address.localeCompare(b.address);
  });
  return result;
}

function getLocalIP() {
  const all = getAllUsableInterfaces();
  const preferred = all.find(c => c.address.startsWith('192.168') || c.address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(c.address));
  return preferred ? preferred.address : (all[0] ? all[0].address : '127.0.0.1');
}

function getLocalIPs() {
  return getAllUsableInterfaces().map(i => i.address);
}

function getSubnet() {
  const ip = getLocalIP();
  const parts = ip.split('.');
  return parts[0] + '.' + parts[1] + '.' + parts[2] + '.';
}

/**
 * 验证拨号号码格式（中国大陆手机号、固话、国际号码、400/800）
 */
function isValidDialNumber(number) {
  return /^(\+?[\d\s\-\(\)]{4,20})$/.test(number.replace(/\s/g, ''));
}

// ==================== 初始化时计算的值 ====================
const LOCAL_IP = getLocalIP();
const SUBNET = getSubnet();

module.exports = {
  // 常量
  PORT,
  DISCOVERY_PORT,
  LOCAL_IP,
  SUBNET,
  
  // 可变状态（通过 getter/setter 或直接访问）
  get PIN_CODE() { return PIN_CODE; },
  set PIN_CODE(val) { PIN_CODE = val; },
  
  // 函数
  generatePinCode,
  getMacAddress,
  getAllUsableInterfaces,
  getLocalIP,
  getLocalIPs,
  getSubnet,
  isValidDialNumber
};
