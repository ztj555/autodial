/* ============================================================
 * AutoDial 主题数据 v6（唯一权威源）
 * popup.html / auth.html / content-script.js 共用：
 *  - AD_THEMES:              色相 × 明暗 双维度原始字段
 *  - AD_THEME_LIST:          色相展示顺序
 *  - AD_FLAT(id, mode):      摊平成 v5.x 那种单档扁平对象
 *  - AD_FLAT_ALL(mode):      全量摊平（内容脚本建缓存用）
 *  - AD_THEME_VARS(id, mode): 派生 CSS 变量（popup / auth 消费）
 *  - AD_APPLY_THEME(id, mode): 写入 <html> 的 CSS 变量
 *
 * v6.0 架构变更 —— v5.x 是「9 套主题，每套各自钉死一个明暗」，亮暗混在同一个
 * 列表里，切起来是「亮·暗·暗·暗·暗·暗·亮·暗·暗」，观感随机、没有逻辑。
 * 现拆成两个正交维度：
 *     色相（16 套，见 AD_THEME_LIST）  ×  明暗（light 亮白 / dark 暗夜）
 *
 * 配色数据由 pc-app-go/frontend/themes/theme-data.js 转录而来
 * （该文件 16 套 × 7 档，本文件取 light / dark 两端档位），
 * 因此手机端 / PC 端 / 扩展端在同一色相、同一档位下的颜色逐字节一致。
 *
 * storage：色相 __ad_theme、明暗 __ad_theme_mode（跨端共享）
 * 默认值：sky-blue + light，与手机端 ThemeManager 的
 *        DEFAULT_THEME_ID / DEFAULT_MODE 保持一致
 * ============================================================ */

var AD_THEMES = {
  'sky-blue': {
    name: '天空蓝', icon: '☁', category: 'gradient',
    keywords: ['天空', '清爽', '明亮'],
    defaultMode: 'light',
    modes: {
      light: {
        accent: '#2B6CC4', accentLight: '#4A90E0', accentDark: '#1A56A8',
        bg: '#EBF4FF', bg2: '#FFFFFF', bg3: '#D8ECFC',
        text: '#162840', text2: '#5880A8',
        green: '#40C057', red: '#F03E3E',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#4A90E0,#1A56A8)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#D8ECFC)',
        gradGreen: 'linear-gradient(135deg,#40C057,#329644)',
        gradRed: 'linear-gradient(135deg,#F03E3E,#BB3030)'
      },
      dark: {
        accent: '#4682E6', accentLight: '#74A5F8', accentDark: '#2563EB',
        bg: '#0C1220', bg2: '#141E38', bg3: '#1C2A4C',
        text: '#E4EEFF', text2: '#7098C8',
        green: '#51CF66', red: '#FF6B6B',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#74A5F8,#2563EB)',
        gradIdle: 'linear-gradient(135deg,#141E38,#1C2A4C)',
        gradGreen: 'linear-gradient(135deg,#51CF66,#3FA150)',
        gradRed: 'linear-gradient(135deg,#FF6B6B,#C75353)'
      }
    }
  },
  'dark-gold': {
    name: '暗金', icon: '✦', category: 'tech',
    keywords: ['高贵', '经典', '质感'],
    defaultMode: 'dark',
    modes: {
      light: {
        accent: '#B8860B', accentLight: '#E6A800', accentDark: '#7A5C12',
        bg: '#FAF6ED', bg2: '#FFFFFF', bg3: '#F0EBE0',
        text: '#2C2416', text2: '#7A6B52',
        green: '#27AE60', red: '#C0392B',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#E6A800,#7A5C12)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#F0EBE0)',
        gradGreen: 'linear-gradient(135deg,#27AE60,#1E884B)',
        gradRed: 'linear-gradient(135deg,#C0392B,#962C22)'
      },
      dark: {
        accent: '#C9A84C', accentLight: '#F0C040', accentDark: '#8B6914',
        bg: '#111318', bg2: '#1A1D24', bg3: '#22262F',
        text: '#E8DCC8', text2: '#A09070',
        green: '#2ECC71', red: '#E74C3C',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#F0C040,#8B6914)',
        gradIdle: 'linear-gradient(135deg,#1A1D24,#22262F)',
        gradGreen: 'linear-gradient(135deg,#2ECC71,#249F58)',
        gradRed: 'linear-gradient(135deg,#E74C3C,#B43B2F)'
      }
    }
  },
  'cyber-frost': {
    name: '冰蓝冷峻', icon: '❄', category: 'tech',
    keywords: ['冷峻', '科技感', '专业'],
    defaultMode: 'dark',
    modes: {
      light: {
        accent: '#0097A7', accentLight: '#00ACC1', accentDark: '#00838F',
        bg: '#E8F4FC', bg2: '#FFFFFF', bg3: '#D0E8F5',
        text: '#1A3A5C', text2: '#5A8AAF',
        green: '#00C853', red: '#D32F2F',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#00ACC1,#00838F)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#D0E8F5)',
        gradGreen: 'linear-gradient(135deg,#00C853,#009C41)',
        gradRed: 'linear-gradient(135deg,#D32F2F,#A52525)'
      },
      dark: {
        accent: '#00BCD4', accentLight: '#4DD0E1', accentDark: '#006064',
        bg: '#0A1628', bg2: '#122A45', bg3: '#1A3A5C',
        text: '#E0F0FF', text2: '#7BA3C4',
        green: '#00E676', red: '#FF5252',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#4DD0E1,#006064)',
        gradIdle: 'linear-gradient(135deg,#122A45,#1A3A5C)',
        gradGreen: 'linear-gradient(135deg,#00E676,#00B35C)',
        gradRed: 'linear-gradient(135deg,#FF5252,#C74040)'
      }
    }
  },
  'deep-space': {
    name: '深空紫', icon: '◆', category: 'tech',
    keywords: ['深邃', '神秘', '高端'],
    defaultMode: 'dark',
    modes: {
      light: {
        accent: '#9C27B0', accentLight: '#AB47BC', accentDark: '#8E24AA',
        bg: '#F5F0FF', bg2: '#FFFFFF', bg3: '#EDE5F8',
        text: '#2D1E42', text2: '#7E57C2',
        green: '#00C853', red: '#D32F2F',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#AB47BC,#8E24AA)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#EDE5F8)',
        gradGreen: 'linear-gradient(135deg,#00C853,#009C41)',
        gradRed: 'linear-gradient(135deg,#D32F2F,#A52525)'
      },
      dark: {
        accent: '#BB86FC', accentLight: '#DA98FF', accentDark: '#7B1FA2',
        bg: '#0D0A18', bg2: '#18142E', bg3: '#241E42',
        text: '#E8DEFF', text2: '#9575CD',
        green: '#00E676', red: '#FF5252',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#DA98FF,#7B1FA2)',
        gradIdle: 'linear-gradient(135deg,#18142E,#241E42)',
        gradGreen: 'linear-gradient(135deg,#00E676,#00B35C)',
        gradRed: 'linear-gradient(135deg,#FF5252,#C74040)'
      }
    }
  },
  'cyberpunk': {
    name: '赛博朋克', icon: '⚡', category: 'creative',
    keywords: ['霓虹', '酷炫', '未来'],
    defaultMode: 'dark',
    modes: {
      light: {
        accent: '#00BCD4', accentLight: '#4DD0E1', accentDark: '#0097A7',
        bg: '#F0FAFF', bg2: '#FFFFFF', bg3: '#E0F5FF',
        text: '#1A1A2E', text2: '#665599',
        green: '#00E676', red: '#FF1744',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#4DD0E1,#0097A7)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#E0F5FF)',
        gradGreen: 'linear-gradient(135deg,#00E676,#00B35C)',
        gradRed: 'linear-gradient(135deg,#FF1744,#C71235)'
      },
      dark: {
        accent: '#00FFFF', accentLight: '#80FFFF', accentDark: '#008B8B',
        bg: '#0A0010', bg2: '#150022', bg3: '#220035',
        text: '#F0F0FF', text2: '#8866CC',
        green: '#39FF14', red: '#FF0039',
        textOnAccent: '#1A1A1A',
        gradAccent: 'linear-gradient(135deg,#80FFFF,#008B8B)',
        gradIdle: 'linear-gradient(135deg,#150022,#220035)',
        gradGreen: 'linear-gradient(135deg,#39FF14,#2CC710)',
        gradRed: 'linear-gradient(135deg,#FF0039,#C7002C)'
      }
    }
  },
  'minimalist': {
    name: '极简白', icon: '○', category: 'comfort',
    keywords: ['极简', '干净', '护眼'],
    defaultMode: 'light',
    modes: {
      light: {
        accent: '#555555', accentLight: '#777777', accentDark: '#444444',
        bg: '#FFFFFF', bg2: '#FAFAFA', bg3: '#F0F0F0',
        text: '#1A1A1A', text2: '#888888',
        green: '#43A047', red: '#E53935',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#777777,#444444)',
        gradIdle: 'linear-gradient(135deg,#FAFAFA,#F0F0F0)',
        gradGreen: 'linear-gradient(135deg,#43A047,#347D37)',
        gradRed: 'linear-gradient(135deg,#E53935,#B32C29)'
      },
      dark: {
        accent: '#888888', accentLight: '#AAAAAA', accentDark: '#666666',
        bg: '#1A1A1A', bg2: '#2A2A2A', bg3: '#3A3A3A',
        text: '#E8E8E8', text2: '#999999',
        green: '#4CAF50', red: '#EF5350',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#AAAAAA,#666666)',
        gradIdle: 'linear-gradient(135deg,#2A2A2A,#3A3A3A)',
        gradGreen: 'linear-gradient(135deg,#4CAF50,#3B893E)',
        gradRed: 'linear-gradient(135deg,#EF5350,#BA413E)'
      }
    }
  },
  'glassmorphism': {
    name: '毛玻璃', icon: '◇', category: 'tech',
    keywords: ['玻璃', '半透明', '现代感'],
    defaultMode: 'dark',
    modes: {
      light: {
        accent: '#8B5CF6', accentLight: '#A78BFA', accentDark: '#6D28D9',
        bg: '#E8E0F8', bg2: 'rgba(255,255,255,0.5)', bg3: 'rgba(240,240,250,0.4)',
        text: '#2D2640', text2: '#6B6190',
        green: '#10B981', red: '#EF4444',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#A78BFA,#6D28D9)',
        gradIdle: 'linear-gradient(135deg,rgba(255,255,255,0.5),rgba(240,240,250,0.4))',
        gradGreen: 'linear-gradient(135deg,#10B981,#0C9065)',
        gradRed: 'linear-gradient(135deg,#EF4444,#BA3535)'
      },
      dark: {
        accent: '#A78BFA', accentLight: '#C4B5FD', accentDark: '#7C3AED',
        bg: '#0F0F19', bg2: 'rgba(30,30,50,0.55)', bg3: 'rgba(45,45,70,0.45)',
        text: '#F0EEFF', text2: '#A099CC',
        green: '#34D399', red: '#F87171',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#C4B5FD,#7C3AED)',
        gradIdle: 'linear-gradient(135deg,rgba(30,30,50,0.55),rgba(45,45,70,0.45))',
        gradGreen: 'linear-gradient(135deg,#34D399,#29A577)',
        gradRed: 'linear-gradient(135deg,#F87171,#C15858)'
      }
    }
  },
  'forest-green': {
    name: '森林绿', icon: '♣', category: 'comfort',
    keywords: ['自然', '安静', '护眼'],
    defaultMode: 'light',
    modes: {
      light: {
        accent: '#4CAF50', accentLight: '#66BB6A', accentDark: '#43A047',
        bg: '#F0F8F0', bg2: '#FFFFFF', bg3: '#E8F4E8',
        text: '#1E3A1E', text2: '#5E8A5E',
        green: '#2FA75F', red: '#E53935',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#66BB6A,#43A047)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#E8F4E8)',
        gradGreen: 'linear-gradient(135deg,#2FA75F,#25824A)',
        gradRed: 'linear-gradient(135deg,#E53935,#B32C29)'
      },
      dark: {
        accent: '#81C784', accentLight: '#A5D6A7', accentDark: '#388E3C',
        bg: '#0E1810', bg2: '#182818', bg3: '#223822',
        text: '#E0F0E0', text2: '#7AA07A',
        green: '#69F0AE', red: '#FF8A80',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#A5D6A7,#388E3C)',
        gradIdle: 'linear-gradient(135deg,#182818,#223822)',
        gradGreen: 'linear-gradient(135deg,#69F0AE,#52BB88)',
        gradRed: 'linear-gradient(135deg,#FF8A80,#C76C64)'
      }
    }
  },
  'energetic-orange': {
    name: '活力橙', icon: '☀', category: 'creative',
    keywords: ['活泼', '温暖', '有活力'],
    defaultMode: 'dark',
    modes: {
      light: {
        accent: '#F57C00', accentLight: '#FFA726', accentDark: '#EF6C00',
        bg: '#FFF8F0', bg2: '#FFFFFF', bg3: '#FFEFD5',
        text: '#3D2B1A', text2: '#A07850',
        green: '#4CAF50', red: '#E53935',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#FFA726,#EF6C00)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#FFEFD5)',
        gradGreen: 'linear-gradient(135deg,#4CAF50,#3B893E)',
        gradRed: 'linear-gradient(135deg,#E53935,#B32C29)'
      },
      dark: {
        accent: '#FF9800', accentLight: '#FFB74D', accentDark: '#E65100',
        bg: '#1A1510', bg2: '#2A2018', bg3: '#3A2D20',
        text: '#FFF5E6', text2: '#B08D60',
        green: '#66BB6A', red: '#EF5350',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#FFB74D,#E65100)',
        gradIdle: 'linear-gradient(135deg,#2A2018,#3A2D20)',
        gradGreen: 'linear-gradient(135deg,#66BB6A,#509253)',
        gradRed: 'linear-gradient(135deg,#EF5350,#BA413E)'
      }
    }
  },
  'ocean-blue': {
    name: '海洋蓝', icon: '◎', category: 'comfort',
    keywords: ['清新', '开阔', '平静'],
    defaultMode: 'light',
    modes: {
      light: {
        accent: '#1E88E5', accentLight: '#42A5F5', accentDark: '#1976D2',
        bg: '#F0F6FF', bg2: '#FFFFFF', bg3: '#E3ECF8',
        text: '#152238', text2: '#5C7898',
        green: '#00C853', red: '#E53935',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#42A5F5,#1976D2)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#E3ECF8)',
        gradGreen: 'linear-gradient(135deg,#00C853,#009C41)',
        gradRed: 'linear-gradient(135deg,#E53935,#B32C29)'
      },
      dark: {
        accent: '#42A5F5', accentLight: '#64B5F6', accentDark: '#1565C0',
        bg: '#0B1424', bg2: '#152238', bg3: '#1E3050',
        text: '#E0ECFF', text2: '#7890B8',
        green: '#00E676', red: '#FF5252',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#64B5F6,#1565C0)',
        gradIdle: 'linear-gradient(135deg,#152238,#1E3050)',
        gradGreen: 'linear-gradient(135deg,#00E676,#00B35C)',
        gradRed: 'linear-gradient(135deg,#FF5252,#C74040)'
      }
    }
  },
  'teal-gradient': {
    name: '蓝绿渐变', icon: '≈', category: 'gradient',
    keywords: ['清新', '渐变', '现代'],
    defaultMode: 'light',
    modes: {
      light: {
        accent: '#00899E', accentLight: '#00A5BD', accentDark: '#006D7D',
        bg: '#E8FAFA', bg2: '#FFFFFF', bg3: '#D8F4F6',
        text: '#163840', text2: '#588898',
        green: '#10B890', red: '#E74C3C',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#00A5BD,#006D7D)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#D8F4F6)',
        gradGreen: 'linear-gradient(135deg,#10B890,#0C9070)',
        gradRed: 'linear-gradient(135deg,#E74C3C,#B43B2F)'
      },
      dark: {
        accent: '#00B7C3', accentLight: '#4DD8E0', accentDark: '#007C85',
        bg: '#0A1A1E', bg2: '#122A30', bg3: '#1A3A42',
        text: '#E0F5F8', text2: '#6AAAB8',
        green: '#26D0A0', red: '#FF6B6B',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#4DD8E0,#007C85)',
        gradIdle: 'linear-gradient(135deg,#122A30,#1A3A42)',
        gradGreen: 'linear-gradient(135deg,#26D0A0,#1EA27D)',
        gradRed: 'linear-gradient(135deg,#FF6B6B,#C75353)'
      }
    }
  },
  'mint-fresh': {
    name: '薄荷清新', icon: '✿', category: 'gradient',
    keywords: ['薄荷', '清爽', '自然'],
    defaultMode: 'light',
    modes: {
      light: {
        accent: '#20BF6B', accentLight: '#26DE81', accentDark: '#0B8A42',
        bg: '#EDFFF4', bg2: '#FFFFFF', bg3: '#DFF8E8',
        text: '#1A3820', text2: '#5A9A6A',
        green: '#26DE81', red: '#FC5C65',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#26DE81,#0B8A42)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#DFF8E8)',
        gradGreen: 'linear-gradient(135deg,#26DE81,#1EAD65)',
        gradRed: 'linear-gradient(135deg,#FC5C65,#C5484F)'
      },
      dark: {
        accent: '#2ED573', accentLight: '#7BED9F', accentDark: '#1E8449',
        bg: '#0A1A10', bg2: '#142818', bg3: '#1E3822',
        text: '#E0F8E8', text2: '#6AAF80',
        green: '#7BED9F', red: '#FF6B81',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#7BED9F,#1E8449)',
        gradIdle: 'linear-gradient(135deg,#142818,#1E3822)',
        gradGreen: 'linear-gradient(135deg,#7BED9F,#60B97C)',
        gradRed: 'linear-gradient(135deg,#FF6B81,#C75365)'
      }
    }
  },
  'coral-sunset': {
    name: '珊瑚日落', icon: '◐', category: 'gradient',
    keywords: ['珊瑚', '温暖', '渐变'],
    defaultMode: 'light',
    modes: {
      light: {
        accent: '#E86840', accentLight: '#FF8A65', accentDark: '#D84315',
        bg: '#FFF5EE', bg2: '#FFFFFF', bg3: '#FFE8DD',
        text: '#3D2218', text2: '#A07058',
        green: '#20BF6B', red: '#EE5A24',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#FF8A65,#D84315)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#FFE8DD)',
        gradGreen: 'linear-gradient(135deg,#20BF6B,#199553)',
        gradRed: 'linear-gradient(135deg,#EE5A24,#BA461C)'
      },
      dark: {
        accent: '#FF7F50', accentLight: '#FFA07A', accentDark: '#CD5C5C',
        bg: '#1A1410', bg2: '#2A2018', bg3: '#3A2C20',
        text: '#FFF0E8', text2: '#B08868',
        green: '#2ED573', red: '#FF6348',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#FFA07A,#CD5C5C)',
        gradIdle: 'linear-gradient(135deg,#2A2018,#3A2C20)',
        gradGreen: 'linear-gradient(135deg,#2ED573,#24A65A)',
        gradRed: 'linear-gradient(135deg,#FF6348,#C74D38)'
      }
    }
  },
  'lavender': {
    name: '薰衣草', icon: '❀', category: 'gradient',
    keywords: ['薰衣草', '优雅', '柔和'],
    defaultMode: 'light',
    modes: {
      light: {
        accent: '#7C6FE0', accentLight: '#9B8FFF', accentDark: '#5B4BC9',
        bg: '#F3F0FF', bg2: '#FFFFFF', bg3: '#E8E4FA',
        text: '#2D2640', text2: '#7A70A0',
        green: '#43A047', red: '#E53935',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#9B8FFF,#5B4BC9)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#E8E4FA)',
        gradGreen: 'linear-gradient(135deg,#43A047,#347D37)',
        gradRed: 'linear-gradient(135deg,#E53935,#B32C29)'
      },
      dark: {
        accent: '#A29BFE', accentLight: '#C4BFFF', accentDark: '#6C5CE7',
        bg: '#12101E', bg2: '#1C1A30', bg3: '#282442',
        text: '#ECE8FF', text2: '#9088CC',
        green: '#55EFC4', red: '#FF7675',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#C4BFFF,#6C5CE7)',
        gradIdle: 'linear-gradient(135deg,#1C1A30,#282442)',
        gradGreen: 'linear-gradient(135deg,#55EFC4,#42BA99)',
        gradRed: 'linear-gradient(135deg,#FF7675,#C75C5B)'
      }
    }
  },
  'warm-cream': {
    name: '暖光米色', icon: '☼', category: 'comfort',
    keywords: ['温暖', '舒适', '复古'],
    defaultMode: 'light',
    modes: {
      light: {
        accent: '#C4956A', accentLight: '#D4A574', accentDark: '#967048',
        bg: '#FFF9F0', bg2: '#FFFFFF', bg3: '#F5EDE0',
        text: '#3D3020', text2: '#908068',
        green: '#4CAF50', red: '#EF5350',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#D4A574,#967048)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#F5EDE0)',
        gradGreen: 'linear-gradient(135deg,#4CAF50,#3B893E)',
        gradRed: 'linear-gradient(135deg,#EF5350,#BA413E)'
      },
      dark: {
        accent: '#D4A574', accentLight: '#E8C49A', accentDark: '#A67C52',
        bg: '#1A1612', bg2: '#2A2218', bg3: '#3A2E20',
        text: '#F0E6D8', text2: '#A09080',
        green: '#81C784', red: '#E57373',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#E8C49A,#A67C52)',
        gradIdle: 'linear-gradient(135deg,#2A2218,#3A2E20)',
        gradGreen: 'linear-gradient(135deg,#81C784,#659B67)',
        gradRed: 'linear-gradient(135deg,#E57373,#B35A5A)'
      }
    }
  },
  'rounded-candy': {
    name: '圆润糖果', icon: '●', category: 'comfort',
    keywords: ['圆润', '可爱', '柔和'],
    defaultMode: 'light',
    modes: {
      light: {
        accent: '#EC407A', accentLight: '#F06292', accentDark: '#D81B60',
        bg: '#FFF0F5', bg2: '#FFFFFF', bg3: '#FFE4EC',
        text: '#3D1E2D', text2: '#A06080',
        green: '#00E676', red: '#FF5252',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#F06292,#D81B60)',
        gradIdle: 'linear-gradient(135deg,#FFFFFF,#FFE4EC)',
        gradGreen: 'linear-gradient(135deg,#00E676,#00B35C)',
        gradRed: 'linear-gradient(135deg,#FF5252,#C74040)'
      },
      dark: {
        accent: '#FF6B9D', accentLight: '#FF8FB1', accentDark: '#C2185B',
        bg: '#1A1020', bg2: '#2A1830', bg3: '#3A2040',
        text: '#FFE8F0', text2: '#A07090',
        green: '#69F0AE', red: '#FF8A80',
        textOnAccent: '#FFFFFF',
        gradAccent: 'linear-gradient(135deg,#FF8FB1,#C2185B)',
        gradIdle: 'linear-gradient(135deg,#2A1830,#3A2040)',
        gradGreen: 'linear-gradient(135deg,#69F0AE,#52BB88)',
        gradRed: 'linear-gradient(135deg,#FF8A80,#C76C64)'
      }
    }
  }
};

/* ============================================================
 * 颜色工具（纯函数，popup / auth / content-script 共用）
 * ============================================================ */
/* 颜色解析：同时支持 #RRGGBB 与 rgba(r,g,b,a)。
 * 毛玻璃主题（glassmorphism）的 bg2 / bg3 是半透明值，早期实现只会 parseInt('#..', 16)，
 * 一遇到 rgba 就得到 NaN，派生出的 inputBg / border / heroBorder 全变 NaN —— 弹窗会整片白屏。
 * 这里统一解析成 [r,g,b,a]，alpha 在混合时一并插值。 */
function _adParse(c) {
  if (typeof c !== 'string') return [128, 128, 128, 1];
  if (c.charAt(0) === '#') {
    var n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  var m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return [128, 128, 128, 1];
  var p = m[1].split(',').map(function (s) { return parseFloat(s); });
  return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? p[3] : 1];
}
function _adHexRgb(h) {
  var p = _adParse(h);
  return [p[0], p[1], p[2]];
}
function _adBlend(a, b, p) {
  var A = _adParse(a), B = _adParse(b);
  var ch = [0, 1, 2].map(function (i) {
    return Math.round(A[i] * (100 - p) / 100 + B[i] * p / 100);
  });
  var al = A[3] * (100 - p) / 100 + B[3] * p / 100;
  if (al < 0.999) return 'rgba(' + ch.join(',') + ',' + (Math.round(al * 100) / 100) + ')';
  return '#' + ch.map(function (v) {
    var s = v.toString(16);
    return s.length < 2 ? '0' + s : s;
  }).join('').toUpperCase();
}

/* ============================================================
 * 明暗模式（v6.0 新增维度）
 *
 * v5.x 及以前：9 套主题各自钉死一个明暗，色相和亮度混在同一个下拉里 ——
 * 切起来是「亮·暗·暗·暗·暗·暗·亮·暗·暗」，观感随机。
 * 现在拆成 色相 × 明暗 两个正交维度：先选色相，再选亮 / 暗。
 *
 * 数据与手机端 ThemeManager（7 档）、PC 端 theme-data（7 档）同源，
 * 扩展端只取两端的 light / dark 档。
 * ============================================================ */
var AD_THEME_DEFAULT = 'sky-blue';
var AD_THEME_DEFAULT_MODE = 'light';
var AD_THEME_MODE_KEY = '__ad_theme_mode';
var AD_THEME_MODES = ['light', 'dark'];
var AD_THEME_MODE_LABEL = { light: '亮白', dark: '暗夜' };

/* 色相展示顺序（唯一权威，各端 UI 直接消费，不要再各端各抄一份） */
var AD_THEME_LIST = [
  'sky-blue', 'dark-gold', 'cyber-frost', 'deep-space', 'cyberpunk',
  'minimalist', 'glassmorphism', 'forest-green', 'energetic-orange', 'ocean-blue',
  'teal-gradient', 'mint-fresh', 'coral-sunset', 'lavender', 'warm-cream', 'rounded-candy'
];

function AD_NORM_MODE(m) { return m === 'dark' ? 'dark' : 'light'; }

/* 其他端存的是 7 档（dark/dusk/dawn/twilight/warm/mist/light），扩展端只有 2 档，
 * 按「哪一端更接近」折叠：4 个深档 → dark，3 个浅档 → light。
 * 手机端与 PC 端默认档都是 light，折叠后仍落在 light，跨端默认态不变。 */
function AD_MODE_FROM_ANY(m) {
  if (m === 'warm' || m === 'mist' || m === 'light') return 'light';
  return 'dark';
}

function AD_HAS_THEME(id) {
  return !!(id && Object.prototype.hasOwnProperty.call(AD_THEMES, id));
}

/* 把 色相 + 明暗 摊平成 v5.x 那种扁平对象（accent / gradAccent / bg2 ... 直接可读）。
 * content-script 里 60+ 处 t.accent / t.bg2 的消费点因此一行都不用改。 */
function AD_FLAT(id, mode) {
  var key = AD_HAS_THEME(id) ? id : AD_THEME_DEFAULT;
  var th = AD_THEMES[key];
  var mk = AD_NORM_MODE(mode);
  var m = th.modes[mk] || th.modes[AD_THEME_DEFAULT_MODE] || th.modes.light;
  var out = { id: key, name: th.name, icon: th.icon, category: th.category, mode: mk };
  Object.keys(m).forEach(function (k) { out[k] = m[k]; });
  return out;
}

/* 全量摊平，供内容脚本重建主题缓存：切一次明暗，整张表重新摊平即可 */
function AD_FLAT_ALL(mode) {
  var out = {};
  Object.keys(AD_THEMES).forEach(function (id) { out[id] = AD_FLAT(id, mode); });
  return out;
}

/* 默认态（天空蓝 × 亮白）直接返回设计 Token 表权威值，不经过 blend 派生，
 * 保证 popup / auth 默认态与手机端、PC 端、云端默认视觉逐字一致。
 * 表中数值是 v5.x 手工调校的结果，改主题数据时不要顺手"优化"。 */
var AD_TOKEN_OVERRIDES = {
  'sky-blue|light': {
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
  }
};

/* 派生 CSS 变量：popup / auth 消费；派生规则与手机端 ThemeManager blend 思路一致 */
function AD_THEME_VARS(id, mode) {
  var mk = AD_NORM_MODE(mode);
  var key = (AD_HAS_THEME(id) ? id : AD_THEME_DEFAULT) + '|' + mk;
  if (AD_TOKEN_OVERRIDES[key]) return AD_TOKEN_OVERRIDES[key];
  var t = AD_FLAT(id, mk);
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
    /* 供半透明辉光（状态点呼吸光晕、危险按钮底）使用 —— 此前这些 rgba 被硬编码为
     * 天空蓝的 64,192,87 / 240,62,62，切换主题后不跟随，出现"蓝灰配绿"的错色 */
    greenRgb: _adHexRgb(t.green).join(','),
    redRgb: _adHexRgb(t.red).join(',')
  };
}

/* 把主题写入 <html> 的 CSS 变量，并标记 dataset.theme / dataset.themeMode。
 * v5.5: 原先 popup 的 theme-init.js 与 auth 的 auth.js 各抄了一份同样的映射表，
 * 弹窗里做运行时切换还得再抄第三份 → 统一收口到本函数（唯一权威实现）。
 * v6.0: 增加 mode 参数（light / dark），返回该组合的派生变量对象。 */
function AD_APPLY_THEME(id, mode) {
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
  var mk = AD_NORM_MODE(mode);
  var key = AD_HAS_THEME(id) ? id : AD_THEME_DEFAULT;
  var t = AD_THEME_VARS(key, mk);
  var r = document.documentElement.style;
  Object.keys(MAP).forEach(function (k) {
    if (t[MAP[k]] != null) r.setProperty(k, t[MAP[k]]);
  });
  document.documentElement.dataset.theme = key;
  document.documentElement.dataset.themeMode = mk;
  return t;
}
