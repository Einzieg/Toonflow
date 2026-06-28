import settingStore from "@/stores/setting";
const REEL_REGEX = /^\s*(第\s*[\d０-９零〇一二三四五六七八九十百千万两]+\s*卷)\s*[：:、.．\-—]?\s*([^\n\r]*)$/gm;
const DEFAULT_CHAPTER_REGEX =
  /^\s*第\s*([0-9０-９零〇一二三四五六七八九十百千万两]+)\s*[章回节集](?:\s*[：:、.．\-—]\s*|\s+|$)([^\n\r]*)$/gm;
const CHINESE_NUM_MAP: { [key: string]: number } = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CHINESE_UNIT_MAP: { [key: string]: number } = {
  十: 10,
  百: 100,
  千: 1000,
  万: 10000,
};
interface Chapter {
  index: number;
  chapter: string;
  text: string;
}
interface Reel {
  index: number;
  reel: string;
  chapters: Chapter[];
}
function parseNumber(numStr: string): number {
  const normalized = numStr
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 65248))
    .replace(/\s/g, "")
    .replace(/[第章节回集卷]/g, "");
  if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);
  if (/^十[一二三四五六七八九]?$/.test(normalized)) {
    if (normalized.length === 1) return 10;
    return 10 + CHINESE_NUM_MAP[normalized[1]];
  }
  let num = 0,
    digit = 0;
  for (const c of normalized) {
    if (CHINESE_NUM_MAP[c] !== undefined) digit = CHINESE_NUM_MAP[c];
    else if (CHINESE_UNIT_MAP[c] !== undefined) {
      if (digit === 0 && c === "十") digit = 1;
      num += digit * CHINESE_UNIT_MAP[c];
      digit = 0;
    }
  }
  num += digit;
  return num;
}

function cleanHeadingTitle(title?: string): string {
  return (title ?? "").replace(/^[\s：:、.．\-—]+/, "").trim();
}

function ensureGlobalRegex(regex: RegExp): RegExp {
  return regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
}

function isLineStartMatch(source: string, index: number): boolean {
  const prevLf = source.lastIndexOf("\n", index - 1);
  const prevCr = source.lastIndexOf("\r", index - 1);
  const lineStart = Math.max(prevLf, prevCr) + 1;
  return source.slice(lineStart, index).trim() === "";
}

function getHeaderMatches(source: string, regex: RegExp): RegExpMatchArray[] {
  const safeRegex = ensureGlobalRegex(regex);
  safeRegex.lastIndex = 0;
  return Array.from(source.matchAll(safeRegex)).filter((match) => isLineStartMatch(source, match.index ?? 0));
}

function getChapterRegex(): RegExp {
  const regStr = settingStore().otherSetting.chapterReg;
  if (!regStr) return DEFAULT_CHAPTER_REGEX;
  const match = regStr.match(/^\/(.*)\/([igmuy]*)$/);
  if (match) {
    const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
    return new RegExp(match[1], flags);
  }
  return new RegExp(regStr, "g");
}
export default function parseNovel(text: string): Reel[] {
  REEL_REGEX.lastIndex = 0;
  const reelMatches = getHeaderMatches(text, REEL_REGEX);
  const reels: Reel[] = [];
  const CHAPTER_REGEX = getChapterRegex();

  // 没有卷结构
  if (reelMatches.length === 0) {
    const chapters: Chapter[] = [];
    const matches = getHeaderMatches(text, CHAPTER_REGEX);
    if (matches.length === 0 && text.trim() !== "") {
      chapters.push({ index: 1, chapter: "", text: text.trim() });
    } else {
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index! + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
        const content = text
          .slice(start, end)
          .replace(/^[\r\n]+/, "")
          .trim();
        chapters.push({
          index: parseNumber(matches[i][1]),
          chapter: cleanHeadingTitle(matches[i][2]),
          text: content,
        });
      }
    }
    // 对章节排序
    chapters.sort((a, b) => a.index - b.index);
    reels.push({
      index: 1,
      reel: "正文卷",
      chapters,
    });
    return reels;
  }

  // 有卷结构
  const reelMap = new Map<string, Reel>();
  for (let i = 0; i < reelMatches.length; i++) {
    const match = reelMatches[i];
    const index = match.index!;
    const reelRaw = match[1];
    const reelName = cleanHeadingTitle(match[2]) || reelRaw.replace(/\s/g, "");
    const end = i + 1 < reelMatches.length ? reelMatches[i + 1].index! : text.length;
    const reelSection = text.slice(index, end);

    const chapterMatches = getHeaderMatches(reelSection, CHAPTER_REGEX);
    const chapters: Chapter[] = [];
    if (chapterMatches.length === 0 && reelSection.replace(REEL_REGEX, "").trim() !== "") {
      chapters.push({
        index: 1,
        chapter: "",
        text: reelSection.replace(REEL_REGEX, "").trim(),
      });
    }
    for (let j = 0; j < chapterMatches.length; j++) {
      const start = chapterMatches[j].index! + chapterMatches[j][0].length;
      const end = j + 1 < chapterMatches.length ? chapterMatches[j + 1].index! : reelSection.length;
      const content = reelSection
        .slice(start, end)
        .replace(/^[\r\n]+/, "")
        .trim();
      chapters.push({
        index: parseNumber(chapterMatches[j][1]),
        chapter: cleanHeadingTitle(chapterMatches[j][2]),
        text: content,
      });
    }
    // 每卷内章节排序
    chapters.sort((a, b) => a.index - b.index);

    if (!reelMap.has(reelName)) {
      reelMap.set(reelName, {
        index: parseNumber(reelRaw),
        reel: reelName,
        chapters: [],
      });
    }
    reelMap.get(reelName)!.chapters.push(...chapters);
  }
  // 按卷序号排序输出
  const result = Array.from(reelMap.values()).sort((a, b) => a.index - b.index);
  // 再次确保合并同名卷后，章节整体排序
  result.forEach((reel) => reel.chapters.sort((a, b) => a.index - b.index));
  return result;
}
