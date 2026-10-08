export interface LoadingVerse {
  text: string;
  reference: string;
}

/** Berean Standard Bible (public domain), bundled so loading screens never wait on a fetch. */
export const LOADING_VERSES: readonly LoadingVerse[] = [
  { reference: "Psalm 27:14", text: "Wait patiently for the LORD; be strong and courageous. Wait patiently for the LORD!" },
  { reference: "Psalm 46:10", text: "Be still and know that I am God." },
  { reference: "Lamentations 3:25", text: "The LORD is good to those who wait for Him, to the soul who seeks Him." },
  { reference: "Psalm 62:1", text: "In God alone my soul finds rest; my salvation comes from Him." },
  { reference: "Psalm 130:5", text: "I wait for the LORD; my soul does wait, and in His word I put my hope." },
  { reference: "Exodus 14:14", text: "The LORD will fight for you; you need only to be still." },
  { reference: "Psalm 4:8", text: "I will lie down and sleep in peace, for You alone, O LORD, make me dwell in safety." },
  { reference: "Isaiah 40:31", text: "But those who wait upon the LORD will renew their strength." },
];

/** Wraps any number (negative or fractional too) into the list. */
export function loadingVerse(seed: number): LoadingVerse {
  const n = LOADING_VERSES.length;
  const i = Number.isFinite(seed) ? Math.floor(seed) : 0;
  return LOADING_VERSES[((i % n) + n) % n];
}
