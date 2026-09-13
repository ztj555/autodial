/* ============================================================
 * AutoDial 主题数据 v5（唯一权威源）
 * popup.html / auth.html / content-script.js 共用：
 *  - AD_THEMES:      主题原始字段（与旧 EXT_THEMES 兼容）
 *  - AD_THEME_VARS:  派生 CSS 变量（popup/auth 消费）
 * 默认主题 sky-blue，与手机端 ThemeManager DEFAULT_THEME_ID 一致
 * ============================================================ */
var AD_THEMES = {
  'sky-blue': {
    name: '天空蓝', icon: '☁',
    accent: '#2B6CC4', accentLight: '#4A90E0', accentDark: '#1A56A8',
    bg: '#EBF4FF', bg2: '#FFFFFF', bg3: '#D8ECFC',
    text: '#162840', text2: '#5880A8',
    green: '#40C057', red: '#F03E3E',
    textOnAccent: '#FFFFFF',
    gradAccent: 'linear-gradient(135deg,#4A90E0,#1A56A8)',
    gradIdle: 'linear-gradient(135deg,#FFFFFF,#D8ECFC)',
    gradGreen: 'linear-gradient(135deg,#40C057,#2B9E46)',
    gradRed: 'linear-gradient(135deg,#F03E3E,#D32F2F)',
  },
  'dark-gold': {
    name: '暗金', icon: '✦',
    accent: '#C9A84C', accentLight: '#F0C040', accentDark: '#8B6914',
    bg: '#111318', bg2: '#1A1D24', bg3: '#22262F',
    text: '#E8DCC8', text2: '#A09070',
    green: '#2ECC71', red: '#E74C3C',
    textOnAccent: '#FFFFFF',
    gradAccent: 'linear-gradient(135deg,#C9A84C,#8B6914)',
    gradIdle: 'linear-gradient(135deg,#5b5b5b,#333)',
    gradGreen: 'linear-gradient(135deg,#2ECC71,#27AE60)',
    gradRed: 'linear-gradient(135deg,#E74C3C,#C0392B)',
  },
  'cyber-frost': {
    name: '冰蓝冷峻', icon: '❄',
    accent: '#00BCD4', accentLight: '#4DD0E1', accentDark: '#006064',
    bg: '#0A1628', bg2: '#122A45', bg3: '#1A3A5C',
    text: '#E0F0FF', text2: '#7BA3C4',
    green: '#00E676', red: '#FF5252',
    textOnAccent: '#FFFFFF',
    gradAccent: 'linear-gradient(135deg,#00BCD4,#006064)',
    gradIdle: 'linear-gradient(135deg,#1A3A5C,#0A1628)',
    gradGreen: 'linear-gradient(135deg,#00E676,#00C853)',
    gradRed: 'linear-gradient(135deg,#FF5252,#D32F2F)',
  },
  'deep-space': {
    name: '深空紫', icon: '◆',
    accent: '#BB86FC', accentLight: '#DA98FF', accentDark: '#7B1FA2',
    bg: '#0D0A18', bg2: '#18142E', bg3: '#241E42',
    text: '#E8DEFF', text2: '#9575CD',
    green: '#00E676', red: '#FF5252',
    textOnAccent: '#FFFFFF',
    gradAccent: 'linear-gradient(135deg,#BB86FC,#7B1FA2)',
    gradIdle: 'linear-gradient(135deg,#241E42,#0D0A18)',
    gradGreen: 'linear-gradient(135deg,#00E676,#00C853)',
    gradRed: 'linear-gradient(135deg,#FF5252,#C0392B)',
  },
  'cyberpunk': {
    name: '赛博朋克', icon: '⚡',
    accent: '#00FFFF', accentLight: '#80FFFF', accentDark: '#008B8B',
    bg: '#0A0010', bg2: '#150022', bg3: '#220035',
    text: '#F0F0FF', text2: '#8866CC',
    green: '#39FF14', red: '#FF0039',
    textOnAccent: '#FFFFFF',
    gradAccent: 'linear-gradient(135deg,#00FFFF,#008B8B)',
    gradIdle: 'linear-gradient(135deg,#220035,#0A0010)',
    gradGreen: 'linear-gradient(135deg,#39FF14,#00C853)',
    gradRed: 'linear-gradient(135deg,#FF0039,#C0392B)',
  },
  'minimalist': {
    name: '极简白', icon: '○',
    accent: '#888888', accentLight: '#AAAAAA', accentDark: '#666666',
    bg: '#1A1A1A', bg2: '#2A2A2A', bg3: '#3A3A3A',
    text: '#E8E8E8', text2: '#999999',
    green: '#4CAF50', red: '#EF5350',
    textOnAccent: '#FFFFFF',
    gradAccent: 'linear-gradient(135deg,#888888,#666666)',
    gradIdle: 'linear-gradient(135deg,#3A3A3A,#1A1A1A)',
    gradGreen: 'linear-gradient(135deg,#4CAF50,#388E3C)',
    gradRed: 'linear-gradient(135deg,#EF5350,#C62828)',
  },
  'forest-green': {
    // v5.5: 由墨绿深色改为「森林晨雾」浅色版 —— 原配色 bg #0E1810 近乎纯黑，
    // 九套主题里最压抑的一套，弹窗里文字/数值/图标全是同一族绿，观感发闷。
    // 现统一采用与手机端/PC 端 forest-green「亮白(light)」档相同的清爽绿。
    name: '森林绿', icon: '♣',
    accent: '#4CAF50', accentLight: '#66BB6A', accentDark: '#43A047',
    bg: '#F0F8F0', bg2: '#FFFFFF', bg3: '#E8F4E8',
    text: '#1E3A1E', text2: '#5E8A5E',
    green: '#2FA75F', red: '#E53935',
    textOnAccent: '#FFFFFF',
    gradAccent: 'linear-gradient(135deg,#66BB6A,#43A047)',
    gradIdle: 'linear-gradient(135deg,#FFFFFF,#E8F4E8)',
    gradGreen: 'linear-gradient(135deg,#2FA75F,#1E8A4A)',
    gradRed: 'linear-gradient(135deg,#E53935,#C0392B)',
  },
  'energetic-orange': {
    name: '活力橙', icon: '☀',
    accent: '#FF9800', accentLight: '#FFB74D', accentDark: '#E65100',
    bg: '#1A1510', bg2: '#2A2018', bg3: '#3A2D20',
    text: '#FFF5E6', text2: '#B08D60',
    green: '#66BB6A', red: '#EF5350',
    textOnAccent: '#FFFFFF',
    gradAccent: 'linear-gradient(135deg,#FF9800,#E65100)',
    gradIdle: 'linear-gradient(135deg,#3A2D20,#1A1510)',
    gradGreen: 'linear-gradient(135deg,#66BB6A,#388E3C)',
    gradRed: 'linear-gradient(135deg,#EF5350,#C62828)',
  },
  'ocean-blue': {
    name: '海洋蓝', icon: '◎',
    accent: '#42A5F5', accentLight: '#64B5F6', accentDark: '#1565C0',
    bg: '#0B1424', bg2: '#152238', bg3: '#1E3050',
    text: '#E0ECFF', text2: '#7890B8',
    green: '#00E676', red: '#FF5252',
    textOnAccent: '#FFFFFF',
    gradAccent: 'linear-gradient(135deg,#42A5F5,#1565C0)',
    gradIdle: 'linear-gradient(135deg,#1E3050,#0B1424)',
    gradGreen: 'linear-gradient(135deg,#00E676,#00C853)',
    gradRed: 'linear-gradient(135deg,#FF5252,#C62828)',
  },
};

/* 颜色工具（纯函数，popup/auth 与 content-script 共用） */
function _adHexRgb(h) {
  var n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function _adBlend(a, b, p) {
  var A = _adHexRgb(a), B = _adHexRgb(b);
  return '#' + [0, 1, 2].map(function (i) {
    var v = Math.round(A[i] * (100 - p) / 100 + B[i] * p / 100);
    var s = v.toString(16);
    return s.length < 2 ? '0' + s : s;
  }).join('').toUpperCase();
}

/* 派生 CSS 变量：popup/auth 消费；派生规则与手机端 ThemeManager blend 思路一致 */
function AD_THEME_VARS(id) {
  var t = AD_THEMES[id] || AD_THEMES['sky-blue'];
  // 默认天空蓝直接返回设计 Token 表权威值（不经过 blend 派生），
  // 保证 popup/auth 默认态与手机端/云端默认视觉逐字一致
  if (id === 'sky-blue') {
    return {
      bg: '#EBF4FF', bg2: '#FFFFFF', bg3: '#D8ECFC',
      inputBg: '#F4F8FC', iconTile: '#EDF5FD',
      borderC: '#DCEAF7', borderInput: '#DFEBF6', divider: '#E4EBF1',
      heroBorder: '#BFD9F2', heroTop: '#EDF4FC',
      bannerInfoBg: '#E3EEFB', bannerInfoBorder: '#C4DAF3',
      text: '#162840', text2: '#5880A8',
      accent: '#2B6CC4', accentLight: '#4A90E0', accentDark: '#1A56A8',
      green: '#40C057', red: '#F03E3E',
      primaryRgb: '43,108,196',
      greenRgb: '64,192,87', redRgb: '240,62,62'
    };
  }
  return {
    bg: t.bg, bg2: t.bg2, bg3: t.bg3,
    inputBg: _adBlend(t.bg2, t.bg3, 55),
    iconTile: _adBlend(t.bg2, t.accent, 8),
    borderC: _adBlend(t.bg2, t.text2, 26),
    borderInput: _adBlend(t.bg2, t.text2, 20),
    divider: _adBlend(t.bg2, t.text2, 14),
    heroBorder: _adBlend(t.bg2, t.accent, 52),
    heroTop: _adBlend(t.bg2, t.accent, 5),
    bannerInfoBg: _adBlend(t.bg2, t.accent, 10),
    bannerInfoBorder: _adBlend(t.bg2, t.accent, 32),
    text: t.text, text2: t.text2,
    accent: t.accent, accentLight: t.accentLight, accentDark: t.accentDark,
    green: t.green, red: t.red,
    primaryRgb: _adHexRgb(t.accent).join(','),
    // v5.5: 供半透明辉光（状态点呼吸光晕、危险按钮底）使用 —— 此前这些 rgba 被硬编码为
    // 天空蓝的 64,192,87 / 240,62,62，切换主题后不跟随，出现"蓝灰配绿"的错色
    greenRgb: _adHexRgb(t.green).join(','),
    redRgb: _adHexRgb(t.red).join(',')
  };
}

/* 把主题写入 <html> 的 CSS 变量。
 * v5.5: 原先 popup 的 theme-init.js 与 auth 的 auth.js 各抄了一份同样的映射表，
 * 弹窗里做运行时切换还得再抄第三份 → 统一收口到本函数（唯一权威实现）。
 * 返回该主题的派生变量对象，调用方可直接复用。 */
function AD_APPLY_THEME(id) {
  var MAP = {
    '--bg': 'bg', '--surface': 'bg2', '--surface-2': 'bg3', '--input-bg': 'inputBg',
    '--icon-tile': 'iconTile', '--border': 'borderC', '--border-input': 'borderInput',
    '--divider': 'divider', '--hero-border': 'heroBorder', '--hero-top': 'heroTop',
    '--text': 'text', '--text-2': 'text2',
    '--primary': 'accent', '--primary-light': 'accentLight', '--primary-dark': 'accentDark',
    '--green': 'green', '--red': 'red',
    '--banner-info-bg': 'bannerInfoBg', '--banner-info-border': 'bannerInfoBorder',
    '--primary-rgb': 'primaryRgb',
    '--green-rgb': 'greenRgb', '--red-rgb': 'redRgb'
  };
  var t = AD_THEME_VARS(id);
  var r = document.documentElement.style;
  Object.keys(MAP).forEach(function (k) {
    if (t[MAP[k]] != null) r.setProperty(k, t[MAP[k]]);
  });
  document.documentElement.dataset.theme = id;
  return t;
}
