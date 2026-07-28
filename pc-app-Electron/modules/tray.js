'use strict';
/**
 * 系统托盘模块
 * 
 * 用法:
 *   const trayModule = require('./modules/tray');
 *   const tray = trayModule.createTray(app, mainWindow, floatBarWindow);
 * 
 * 返回: { tray, createTrayIcon }
 */

const { Tray, Menu, nativeImage } = require('electron');
const crypto = require('crypto');
const zlib = require('zlib');

/**
 * 程序化生成 16x16 金色电话图标 PNG
 */
function createTrayIconPNG() {
  const W = 16, H = 16;
  const pixels = Buffer.alloc(W * H * 4, 0); // 全透明

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = a;
  }

  const GOLD = [201, 168, 76, 255];
  const DARK = [139, 105, 20, 255];

  // 听筒主体 - 上半部分
  for (let y = 3; y <= 8; y++) {
    for (let x = 4; x <= 11; x++) {
      setPixel(x, y, ...GOLD);
    }
  }
  // 听筒耳机部分 - 左上
  for (let y = 2; y <= 5; y++) {
    for (let x = 3; x <= 5; x++) {
      setPixel(x, y, ...DARK);
    }
  }
  // 听筒耳机部分 - 右上
  for (let y = 2; y <= 5; y++) {
    for (let x = 10; x <= 12; x++) {
      setPixel(x, y, ...DARK);
    }
  }
  // 听筒底部弧线
  for (let x = 5; x <= 10; x++) {
    setPixel(x, 9, ...GOLD);
  }
  for (let x = 6; x <= 9; x++) {
    setPixel(x, 10, ...GOLD);
  }
  setPixel(7, 11, ...GOLD);
  setPixel(8, 11, ...GOLD);
  // 底座
  for (let x = 4; x <= 11; x++) {
    setPixel(x, 12, ...DARK);
    setPixel(x, 13, ...DARK);
  }

  // 编码为 PNG（最小有效PNG）
  const rawData = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    rawData[y * (1 + W * 4)] = 0; // filter: None
    pixels.copy(rawData, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const compressed = zlib.deflateSync(rawData);

  function crc32(buf) {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return nativeImage.createFromBuffer(
    Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]),
    { width: W, height: H }
  );
}

/**
 * 创建系统托盘
 * @param {object} app - Electron app 对象
 * @param {object} mainWindow - 主窗口引用
 * @param {object} floatBarWindow - 悬浮条窗口引用
 * @returns {Tray} tray 对象
 */
function createTray(app, mainWindow, floatBarWindow) {
  const trayIcon = createTrayIconPNG();
  const tray = new Tray(trayIcon);
  tray.setToolTip('AutoDial 一键拨号');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '显示悬浮条', click: () => { if (floatBarWindow) floatBarWindow.show(); } },
    { label: '隐藏悬浮条', click: () => { if (floatBarWindow) floatBarWindow.hide(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; if (tray) { tray.destroy(); } app.quit(); } }
  ]));

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return tray;
}

module.exports = {
  createTray,
  createTrayIconPNG
};
