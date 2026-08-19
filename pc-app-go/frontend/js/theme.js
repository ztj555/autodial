/**
 * AutoDial PC端 - 主题引擎
 * 负责 CSS 变量注入、主题应用、跨窗口同步
 * 支持 dark / dusk / dawn / twilight / warm / mist / light 七种亮度模式
 */

(function() {
  'use strict';

  let currentThemeId = DEFAULT_THEME || 'lavender';
  let currentMode = DEFAULT_MODE || 'light';

  // 查找主题数据
  function findTheme(id) {
    return THEME_DATA.find(t => t.id === id) || THEME_DATA[0];
  }

  // 将对象写入 document.documentElement.style
  function setCSSVars(vars) {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(vars)) {
      const cssKey = '--' + key.replace(/([A-Z])/g, '-$1').toLowerCase();
      root.style.setProperty(cssKey, value);
    }
  }

  // CSS变量名映射：JS驼峰 -> CSS连字符
  const COLOR_MAP = {
    gold: 'primary', goldLight: 'primary-light', goldDark: 'primary-dark',
    bg: 'bg', bg2: 'surface', bg3: 'surface-2',
    text: 'text', text2: 'text-2',
    green: 'green', red: 'red',
    floatbarBg: 'floatbar-bg', floatbarBorder: 'floatbar-border', floatbarBlur: 'floatbar-blur'
  };

  // 颜色工具：blend 派生规则与插件端 themes.js 一致
  function _hexRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function _blend(a, b, p) {
    const A = _hexRgb(a), B = _hexRgb(b);
    return '#' + [0, 1, 2].map(i => {
      const v = Math.round(A[i] * (100 - p) / 100 + B[i] * p / 100);
      return v.toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  }

  const STYLE_MAP = {
    radiusSm: 'radius-sm', radiusMd: 'radius-md', radiusLg: 'radius-lg',
    shadow: 'shadow', fontFamily: 'font-family',
    gradientGreen: 'gradient-green', gradientRed: 'gradient-red',
    glowText: 'glow-text', backdropFilter: 'backdrop-filter'
  };

  // 应用主题（主入口）
  function applyTheme(themeId, mode) {
    currentThemeId = themeId || currentThemeId;
    currentMode = mode || currentMode;

    const theme = findTheme(currentThemeId);
    // 优先使用指定模式，没有则回退
    const colors = theme[currentMode] || theme.dark;

    // 注入颜色变量（含 floatbar 相关）——变量名取 COLOR_MAP 的 value（语义名）
    const colorVars = {};
    for (const [jsKey, cssName] of Object.entries(COLOR_MAP)) {
      if (colors[jsKey] !== undefined) {
        colorVars[cssName] = colors[jsKey];
      }
    }
    setCSSVars(colorVars);

    // 注入派生 token（blend 规则与插件端 themes.js 一致）
    const derived = {
      inputBg:       _blend(colors.bg2, colors.bg3, 55),
      iconTile:      _blend(colors.bg2, colors.gold, 8),
      border:        _blend(colors.bg2, colors.text2, 26),
      borderInput:   _blend(colors.bg2, colors.text2, 20),
      divider:       _blend(colors.bg2, colors.text2, 14),
      heroBorder:    _blend(colors.bg2, colors.gold, 52),
      heroTop:       _blend(colors.bg2, colors.gold, 5),
      bannerInfoBg:  _blend(colors.bg2, colors.gold, 10),
      bannerInfoBorder: _blend(colors.bg2, colors.gold, 32)
    };
    setCSSVars(derived);
    const root = document.documentElement;
    root.style.setProperty('--primary-rgb', _hexRgb(colors.gold).join(','));
    root.style.setProperty('--grad-btn',  'linear-gradient(180deg, ' + colors.goldLight + ', ' + colors.goldDark + ')');
    root.style.setProperty('--grad-hero', 'linear-gradient(180deg, ' + derived.heroTop + ', ' + colors.bg2 + ')');

    // 注入风格变量
    if (theme.style) {
      setCSSVars(theme.style);
    }

    // 发光文字效果
    if (theme.style.glowText && theme.style.glowText !== 'none') {
      const root = document.documentElement;
      root.style.setProperty('--glow-text', theme.style.glowText);
    } else {
      document.documentElement.style.removeProperty('--glow-text');
    }

    // 通知主进程更新窗口背景色（避免白闪）
    try {
      window.api.send('update-bg-color', colors.bg);
    } catch(e) {}
  }

  // 初始化：从主进程拉取当前设置并应用
  function initTheme() {
    // 先应用默认主题，避免白闪
    applyTheme(DEFAULT_THEME, DEFAULT_MODE);

    // 然后尝试从主进程获取真实设置
    if (typeof window !== 'undefined' && window.api) {
      window.api.invoke('get-theme-setting').then(setting => {
        if (setting) {
          applyTheme(setting.theme, setting.mode);
        }
      }).catch(() => {});

      // 监听其他窗口触发的主题变更
      window.api.on('theme-changed', (data) => {
        applyTheme(data.theme || data.id, data.mode);
      });
    }
  }

  // 获取当前主题信息
  function getCurrentThemeInfo() {
    return {
      id: currentThemeId,
      mode: currentMode,
      theme: findTheme(currentThemeId)
    };
  }

  // 暴露到全局
  window.ThemeEngine = {
    applyTheme,
    initTheme,
    getCurrentThemeInfo,
    findTheme
  };
})();
