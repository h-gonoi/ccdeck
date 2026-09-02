import SPR from '../scene/sprites.json';

/* 住人の絵。部屋の絵（scene/scene.html）と同じ規則で髪と服を決める。
   規則を変えるときは両方を変えること。片方だけ直すと一覧と部屋で別人になる。 */
export type Special = 'butler';

const hash = (s: string) => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
};
const HAIRK = Object.keys(SPR.hair) as (keyof typeof SPR.hair)[];

function lookOf(title: string) {
  const n = hash(title);
  return {
    hair: HAIRK[n % HAIRK.length],
    hairC: SPR.hairColors[(n >>> 2) % SPR.hairColors.length],
    shirt: SPR.shirts[(n >>> 5) % SPR.shirts.length],
  };
}

export const SPRITE_W = SPR.w;
export const SPRITE_H = SPR.h;

export function spriteRows(title: string, special?: Special): string[] {
  const look = lookOf(title);
  const sp = special ? SPR.specials[special] : null;
  const rows = SPR.base.slice();
  (sp ? sp.hair : SPR.hair[look.hair]).forEach((line, k) => { rows[SPR.hairAt + k] = line; });
  if (sp?.rows) for (const [k, line] of Object.entries(sp.rows)) rows[Number(k)] = line;
  return rows;
}

export function spritePalette(title: string, special?: Special): Record<string, string | undefined> {
  const look = lookOf(title);
  const sp = special ? SPR.specials[special] : null;
  return {
    ...SPR.fixed,
    h: look.hairC.h, H: look.hairC.H, C: look.shirt.C, c: look.shirt.c,
    ...(sp ? sp.palette : {}),
  };
}
