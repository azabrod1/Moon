/**
 * The Retro look's pixel icons: 12 × 12 pictures drawn one cell to one
 * interface pixel, as the menus of the time drew theirs. Each becomes an SVG
 * of squares (`shape-rendering: crispEdges`) in a data URI on a custom
 * property of <html>, `--rt-icon-<name>`, which index.html's retro block puts
 * on the rows and buttons. An SVG rather than a PNG so it is exact at any
 * whole-number scale; written here rather than as files so the picture is in
 * the source, a letter per cell.
 */

/** One letter per cell; `.` is clear. */
export const RETRO_ICON_COLOURS: Readonly<Record<string, string>> = {
  k: '#000000', w: '#ffffff', y: '#ffdd22', o: '#ee8822', b: '#3366ee', c: '#77ddff',
  g: '#a0a0a4', d: '#505560', r: '#dd4433', n: '#33bb44',
};

export const RETRO_ICONS: Readonly<Record<string, readonly string[]>> = {
  help: ['....kkkk....', '..kkbbbbkk..', '.kbbwwwwbbk.', '.kbwwbbwwbk.', 'kbbbbbbwwbbk', 'kbbbbbwwbbbk', 'kbbbbwwbbbbk', 'kbbbbwwbbbbk', '.kbbbbbbbbk.', '.kbbbwwbbbk.', '..kkbbbbkk..', '....kkkk....'],
  save: ['kkkkkkkkkkk.', 'kbbwwwwwdbbk', 'kbbwwwwwdbbk', 'kbbwwwwwwbbk', 'kbbbbbbbbbbk', 'kbbbbbbbbbbk', 'kbggggggggbk', 'kbgwwwwwwgbk', 'kbgwkkkkwgbk', 'kbgwwwwwwgbk', 'kbgwkkkkwgbk', 'kkkkkkkkkkkk'],
  journey: ['.....kk.....', '....kyyk....', '....kyyk....', 'kkkkkyykkkkk', 'kyyyyyyyyyyk', '.kyyyyyyyyk.', '..kyyyyyyk..', '..kyyyyyyk..', '.kyyykkyyyk.', '.kyykk.kkyyk', 'kykk.....kyk', 'kk........kk'],
  tour: ['kk..........', 'kwkkkk......', 'kwrrrrkkk...', 'kwrrrrrrrk..', 'kwrrrrrrrk..', 'kwrrrrkkk...', 'kwkkkk......', 'kwk.........', 'kwk.........', 'kwk.........', 'kwk.........', 'kkk.........'],
  map: ['....kkkk....', '..kkggggkk..', '.kgk....kgk.', '.kg......gk.', 'kg...kk...gk', 'kg..kyyk..gk', 'kg..kyyk..gk', 'kg...kk...gk', '.kg.....kbbk', '.kgk....kbbk', '..kkggggkkk.', '....kkkk....'],
  credits: ['..kkkkkkkk..', '.kwwwwwwwwk.', '.kwkkkkkkwk.', '.kwwwwwwwwk.', '.kwkkkkkwwk.', '.kwwwwwwwwk.', '.kwkkkkkkwk.', '.kwwwwwwwwk.', '.kwkkkkwwwk.', '.kwwwwwwwwk.', '.kwwwwwwwwk.', '..kkkkkkkk..'],
  graphics: ['kkkkkkkkkkkk', 'kggggggggggk', 'kgbbbbbbbbgk', 'kgbbcbbbbbgk', 'kgbcbbbbbbgk', 'kgbbbbbbbbgk', 'kgbbbbbbbbgk', 'kggggggggggk', 'kkkkkkkkkkkk', '....kggk....', '..kkkggkkk..', '..kkkkkkkk..'],
  display: ['....kkkk....', '..kkwwddkk..', '.kwwwwddddk.', '.kwwwwddddk.', 'kwwwwwdddddk', 'kwwwwwdddddk', 'kwwwwwdddddk', 'kwwwwwdddddk', '.kwwwwddddk.', '.kwwwwddddk.', '..kkwwddkk..', '....kkkk....'],
  ship: ['.....kk.....', '....kwwk....', '...kwwwwk...', '...kwccwk...', '...kwccwk...', '...kwwwwk...', '..kkwwwwkk..', '.krkwwwwkrk.', '.krkwwwwkrk.', '.kkkkookkkk.', '....kyyk....', '.....kk.....'],
  stars: ['.k..........', 'kyk.........', '.kb.........', '...b........', '....b...k...', '.....b.kyk..', '......b.k...', '......b.....', '.....b......', '..k.b.......', '.kyk........', '..k.........'],
  labels: ['............', '.kkkkkkk....', '.kyyyyyykk..', '.kykyyyyyyk.', '.kyyyyyyyyyk', '.kyyyyyyyyyk', '.kyyyyyyyyk.', '.kyyyyyykk..', '.kkkkkkk....', '............', '............', '............'],
  orbit: ['............', '....kkkk....', '...kooook...', '.bbkooookbb.', 'b..kooook..b', 'b..kooook..b', '.bbkooookbb.', '...kooook...', '....kkkk....', '............', '............', '............'],
  crescent: ['....kkkkk...', '..kkwwwkk...', '.kwwwkk.....', '.kwwk.......', 'kwwwk.......', 'kwwwk.......', 'kwwwk.......', 'kwwwwk......', '.kwwwkk....k', '.kwwwwwkkkkk', '..kkwwwwwkk.', '....kkkkk...'],
};

/** The icon as a crisp SVG: one rect per run of a colour along a row. */
export function retroIconSvg(rows: readonly string[]): string {
  const size = rows.length;
  const rects: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const letter = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === letter) end++;
      if (letter !== '.') rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${RETRO_ICON_COLOURS[letter]}"/>`);
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}

/** `url("data:...")` for a CSS property. */
export function retroIconUrl(rows: readonly string[]): string {
  return `url("data:image/svg+xml,${encodeURIComponent(retroIconSvg(rows))}")`;
}

/** Put every icon on <html> as `--rt-icon-<name>`. Idempotent. */
export function installRetroIcons(root: HTMLElement = document.documentElement): void {
  for (const [name, rows] of Object.entries(RETRO_ICONS)) root.style.setProperty(`--rt-icon-${name}`, retroIconUrl(rows));
}
