export interface ThemeColors {
  readonly bg: string;
  readonly surface: string;
  readonly surfaceElevated: string;
  readonly input: string;
  readonly border: string;
  readonly borderSoft: string;
  readonly text: string;
  readonly textMuted: string;
  readonly textFaint: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly ok: string;
  readonly okSoft: string;
  readonly info: string;
  readonly infoSoft: string;
  readonly warn: string;
  readonly warnSoft: string;
  readonly danger: string;
  readonly dangerSoft: string;
  readonly onAccent: string;
}

export interface ThemeDefinition {
  readonly id: string;
  readonly name: string;
  readonly mode: 'light' | 'dark';
  readonly description: string;
  readonly colors: ThemeColors;
}

export const DEFAULT_THEME_ID = 'morandi';

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'macaron',
    name: '马卡龙',
    mode: 'light',
    description: '奶油底 + 草莓粉 / 薄荷 / 香芋，甜点感、轻盈活泼',
    colors: {
      bg: '#FBF6F2', surface: '#FFFFFF', surfaceElevated: '#FFFFFF', input: '#F7ECEE',
      border: '#F0DFE3', borderSoft: '#F0DFE3AA', text: '#4A3B44', textMuted: '#92808B', textFaint: '#B5A5AE',
      accent: '#E893A8', accentSoft: '#E893A82E', ok: '#77C4B0', okSoft: '#77C4B02E',
      info: '#B4A7E0', infoSoft: '#B4A7E02E', warn: '#EFC06E', warnSoft: '#EFC06E2E',
      danger: '#E2726F', dangerSoft: '#E2726F2E', onAccent: '#4A3B44',
    },
  },
  {
    id: 'morandi',
    name: '莫兰迪',
    mode: 'light',
    description: '高级灰调、低饱和灰豆沙 / 灰绿 / 雾蓝，克制安静',
    colors: {
      bg: '#F1EEE8', surface: '#FAF8F3', surfaceElevated: '#FFFFFF', input: '#E9E3DA',
      border: '#DDD6CC', borderSoft: '#DDD6CC88', text: '#45423D', textMuted: '#837D74', textFaint: '#A39C92',
      accent: '#A9827B', accentSoft: '#A9827B2E', ok: '#8E9B8C', okSoft: '#8E9B8C2E',
      info: '#7E8CA0', infoSoft: '#7E8CA02E', warn: '#C4A77D', warnSoft: '#C4A77D2E',
      danger: '#B5776B', dangerSoft: '#B5776B2E', onAccent: '#FFFFFF',
    },
  },
  {
    id: 'maillard',
    name: '美拉德',
    mode: 'dark',
    description: '深烘焙咖啡底 + 焦糖 / 黄油高光，温暖浓郁',
    colors: {
      bg: '#221410', surface: '#2F1D15', surfaceElevated: '#2F1D15', input: '#3A2419',
      border: '#4A2F20', borderSoft: '#4A2F2099', text: '#F2E4D5', textMuted: '#BFA08A', textFaint: '#8A6B58',
      accent: '#D68B4F', accentSoft: '#D68B4F2E', ok: '#A8C08A', okSoft: '#A8C08A2E',
      info: '#E8C07D', infoSoft: '#E8C07D2E', warn: '#E0A458', warnSoft: '#E0A4582E',
      danger: '#C15B4A', dangerSoft: '#C15B4A2E', onAccent: '#2B1810',
    },
  },
  {
    id: 'forest',
    name: '森林苔绿',
    mode: 'dark',
    description: '墨绿底 + 苔绿 / 晨雾绿，自然沉稳',
    colors: {
      bg: '#0F1A14', surface: '#17261D', surfaceElevated: '#17261D', input: '#1F3125',
      border: '#27392C', borderSoft: '#27392C99', text: '#E4EFE6', textMuted: '#9DB5A4', textFaint: '#6E8574',
      accent: '#6FBF8E', accentSoft: '#6FBF8E2E', ok: '#A3C9A8', okSoft: '#A3C9A82E',
      info: '#7FA8B8', infoSoft: '#7FA8B82E', warn: '#D9C07B', warnSoft: '#D9C07B2E',
      danger: '#D97B6B', dangerSoft: '#D97B6B2E', onAccent: '#0F1A14',
    },
  },
  {
    id: 'ocean',
    name: '靛蓝深海',
    mode: 'dark',
    description: '深夜蓝底 + 靛蓝 / 极光青，理性科技感',
    colors: {
      bg: '#0A1020', surface: '#121B31', surfaceElevated: '#121B31', input: '#1A2540',
      border: '#202C48', borderSoft: '#202C4899', text: '#E3EAF8', textMuted: '#93A3C4', textFaint: '#5D6B8C',
      accent: '#5B8CFF', accentSoft: '#5B8CFF2E', ok: '#56C8E0', okSoft: '#56C8E02E',
      info: '#8FA8FF', infoSoft: '#8FA8FF2E', warn: '#FFC46B', warnSoft: '#FFC46B2E',
      danger: '#FF7A6E', dangerSoft: '#FF7A6E2E', onAccent: '#FFFFFF',
    },
  },
  {
    id: 'terracotta',
    name: '奶油陶土',
    mode: 'light',
    description: '奶油底 + 陶土红 / 焦糖，手作温暖质感',
    colors: {
      bg: '#FAF3EA', surface: '#FFF9F1', surfaceElevated: '#FFF9F1', input: '#F4E7D7',
      border: '#EBDAC8', borderSoft: '#EBDAC8AA', text: '#4B3A2E', textMuted: '#93806F', textFaint: '#B5A48F',
      accent: '#C96F4A', accentSoft: '#C96F4A2E', ok: '#8FAE8B', okSoft: '#8FAE8B2E',
      info: '#DEA276', infoSoft: '#DEA2762E', warn: '#D9A441', warnSoft: '#D9A4412E',
      danger: '#B5544A', dangerSoft: '#B5544A2E', onAccent: '#FFFFFF',
    },
  },
  {
    id: 'lavender',
    name: '薰衣草黄昏',
    mode: 'light',
    description: '雾紫底 + 薰衣草紫 / 蜜桃橙，柔和梦幻',
    colors: {
      bg: '#F5F1FA', surface: '#FFFFFF', surfaceElevated: '#FFFFFF', input: '#EFEAF9',
      border: '#E3DDF3', borderSoft: '#E3DDF3AA', text: '#3F3A55', textMuted: '#8A82A4', textFaint: '#ADA5C2',
      accent: '#7B6CF6', accentSoft: '#7B6CF62E', ok: '#7FC2A8', okSoft: '#7FC2A82E',
      info: '#B8A9F0', infoSoft: '#B8A9F02E', warn: '#EFAF60', warnSoft: '#EFAF602E',
      danger: '#E2708A', dangerSoft: '#E2708A2E', onAccent: '#FFFFFF',
    },
  },
  {
    id: 'graphite',
    name: '石墨青柠',
    mode: 'dark',
    description: '石墨底 + 青柠 / 薄荷绿，锐利现代 dev tools',
    colors: {
      bg: '#121412', surface: '#1B1E1B', surfaceElevated: '#1B1E1B', input: '#232823',
      border: '#2B2F2B', borderSoft: '#2B2F2B99', text: '#EDF2E8', textMuted: '#9AA694', textFaint: '#6B7566',
      accent: '#A9D94F', accentSoft: '#A9D94F2E', ok: '#56D4A0', okSoft: '#56D4A02E',
      info: '#7FB8E0', infoSoft: '#7FB8E02E', warn: '#D9E86B', warnSoft: '#D9E86B2E',
      danger: '#FF6B5E', dangerSoft: '#FF6B5E2E', onAccent: '#121412',
    },
  },
];

export function findTheme(id: string | undefined): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME_ID) ?? THEMES[0]!;
}
