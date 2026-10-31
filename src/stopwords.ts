export const FILLER_WORD_LIST = 'is are was were been being has have had do does did will would shall should can could may might must the a an so just very really quite all also still';

const STOP_WORDS = new Set([
  ...FILLER_WORD_LIST.split(' '),
  ...'that this these those with from they them their then than what when where which your here there about into onto only some more most other because while after before'.split(' '),
]);

/** True for filler and common function words that must not act as excuse keywords. */
export function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word);
}
