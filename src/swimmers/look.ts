/** Deterministic per-swimmer appearance. */

export type Headwear = 'cap' | 'short' | 'bald' | 'bun' | 'long';
export type Suit = 'trunks' | 'briefs' | 'jammers' | 'onepiece' | 'twopiece' | 'rashguard';
export type Facial = 'none' | 'moustache' | 'beard';

export interface Look {
  /** Overall scale; 1.0 is 1.78 m tall. */
  height: number;
  /** -1 slight .. +1 heavy. */
  build: number;
  shoulders: number;
  headWidth: number;
  headHeight: number;
  skin: number;
  hair: number;
  headwear: Headwear;
  capColor: number;
  suit: Suit;
  suitColor: number;
  suitColor2: number;
  goggles: boolean;
  facial: Facial;
  /** Peak flow rate, litres per second. */
  flow: number;
}

export const BASE_HEIGHT_M = 1.78;

const SKIN = [0xf6d3b8, 0xf1c9a5, 0xe6b98f, 0xd9a577, 0xc68e63, 0xae7650, 0x8e5d3d, 0x6f452c, 0x53331f];
const HAIR = [0x17120f, 0x2a1c14, 0x4a3020, 0x6b4a2c, 0xa07840, 0xc9a45e, 0x8f3a1e, 0x8c8c8c, 0xd8d8d6];
const CAPS = [0xf2f2f0, 0x24477a, 0xb3262e, 0x1f1f22, 0x1d7f86, 0xe2b714, 0x6a2d83, 0xe8642c, 0x2f8f4e, 0xd4d7dc];
const SUITS = [
  0x1c2f52, 0x15181d, 0x7a1f2b, 0x0f5a5e, 0x3b2a63, 0x2a4d2e, 0xc2452d, 0x1b6fa8, 0x8a8f96, 0xb0326b, 0xd08a1e,
  0x2c2c6e,
];

/** Perceived brightness of a 0xRRGGBB colour, 0 to 1. */
function luma(hex: number) {
  return (((hex >> 16) & 255) * 0.299 + ((hex >> 8) & 255) * 0.587 + (hex & 255) * 0.114) / 255;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** Different every page load, so the cast changes between sessions. */
const SESSION_SALT = Math.floor(Math.random() * 1e9);

export function makeLook(id: number): Look {
  const r = mulberry32(id * 7919 + SESSION_SALT);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(r() * items.length)];
  const weighted = <T,>(items: readonly [T, number][]) => {
    let total = 0;
    for (const [, w] of items) total += w;
    let x = r() * total;
    for (const [item, w] of items) {
      x -= w;
      if (x <= 0) return item;
    }
    return items[0][0];
  };
  // Sum of two uniforms: values near the middle are more common.
  const bell = () => r() + r() - 1;

  const feminineCut = r() < 0.5;
  const skin = pick(SKIN);
  // Hair that nearly matches the skin reads as a bald scalp (and a beard as a swollen
  // chin), so swap in near-black or grey when the two are too close in brightness.
  let hair = pick(HAIR);
  if (Math.abs(luma(hair) - luma(skin)) < 0.16) hair = Math.abs(luma(0x17120f) - luma(skin)) >= 0.16 ? 0x17120f : 0x8c8c8c;
  const headwear = weighted<Headwear>(
    feminineCut
      ? [['cap', 5], ['bun', 2.5], ['long', 2.5], ['short', 1]]
      : [['cap', 4], ['short', 4], ['bald', 1.5], ['long', 0.5]],
  );
  const suit = weighted<Suit>(
    feminineCut
      ? [['onepiece', 5], ['twopiece', 3], ['rashguard', 1.5]]
      : [['trunks', 4], ['jammers', 2.5], ['briefs', 2], ['rashguard', 1.5]],
  );
  const greying = hair === 0x8c8c8c || hair === 0xd8d8d6;
  return {
    height: 1 + bell() * 0.1 + (feminineCut ? -0.03 : 0.02),
    build: Math.max(-1, Math.min(1, bell() * 1.1 + (greying ? 0.25 : 0))),
    shoulders: 1 + bell() * 0.07 + (feminineCut ? -0.03 : 0.03),
    headWidth: 1 + bell() * 0.05,
    headHeight: 1 + bell() * 0.06,
    skin,
    hair,
    headwear,
    capColor: pick(CAPS),
    suit,
    suitColor: pick(SUITS),
    suitColor2: pick(SUITS),
    goggles: r() < 0.22 && headwear !== 'bald',
    facial: feminineCut ? 'none' : weighted<Facial>([['none', 7], ['moustache', 1], ['beard', 1.5]]),
    flow: 0.02 + r() * 0.014,
  };
}
