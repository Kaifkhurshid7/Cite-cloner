export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WeightedValue {
  value: string;
  weight: number;
}

export interface ExtractedSection {
  index: number;
  tag: string;
  role: 'header' | 'footer' | 'content';
  rect: Rect;
  bg: string | null;
  position: string;
  headings: string[];
  textPreview: string;
  counts: { links: number; images: number; buttons: number };
  /** Compact, annotated DOM of the section (see extract.browser.js). Asset refs look like {{img_3}}. */
  dom: string;
}

export interface ExtractedAsset {
  id: string;
  url: string;
  kind: 'img' | 'bg' | 'svg';
  w?: number;
  h?: number;
  alt?: string;
  svg?: string;
}

export interface Extraction {
  url: string;
  title: string;
  lang: string;
  description: string;
  favicon: string | null;
  ogImage: string | null;
  docHeight: number;
  viewport: { w: number; h: number };
  tokens: {
    bodyBg: string;
    bodyColor: string | null;
    bodyFont: string;
    headingFont: string | null;
    textColors: WeightedValue[];
    bgColors: WeightedValue[];
    buttonColors: WeightedValue[];
    fonts: WeightedValue[];
    fontSizes: WeightedValue[];
    radii: WeightedValue[];
  };
  fontLinks: string[];
  nav: { text: string; href: string }[];
  sections: ExtractedSection[];
  assets: ExtractedAsset[];
}

export interface Analysis extends Extraction {
  /** asset id → path usable from generated code ("media/img_3.webp") or remote URL fallback */
  assetMap: Record<string, string>;
  /** <link> tags to inject into index.html */
  fontHead: string[];
  screenshots: {
    desktopFull: string;
    mobileFull: string;
    sections: string[]; // per section index, absolute paths
  };
  mobileNavCollapsed: boolean;
}
