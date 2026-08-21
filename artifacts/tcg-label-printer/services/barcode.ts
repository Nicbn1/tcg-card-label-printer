/**
 * Code 128B barcode encoder.
 *
 * Returns an array of integer widths (in "units") representing alternating
 * bars and spaces, starting with a bar. Each unit is 1 pixel at the chosen
 * scale. Caller scales to the desired pixel density.
 *
 * Encodes printable ASCII (space–tilde). The card's PriceCharting numeric ID
 * is unique per product and makes an ideal barcode payload.
 */

// Full Code 128 symbol table — values 0..106.
// Each 6-char string = B S B S B S widths (1–4 units each).
// Derived from the ISO/IEC 15417 specification.
const SYMBOLS: string[] = [
  '212222','222122','222221','121223','121322','131222','122213','122312',
  '132212','221213','221312','231212','112232','122132','122231','113222',
  '123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321',
  '232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321',
  '331121','312113','312311','332111','314111','221411','431111','111224',
  '111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112',
  '421211','212141','214121','412121','111143','111341','131141','114113',
  '114311','411113','411311','113141','114131','311141','411131','211412',
  '211214','211232','2331112', // 106 = stop (7 elements, handled separately)
];

const START_B  = 104; // Code 128B start symbol
const STOP_IDX = 106;

/**
 * Encode `data` (printable ASCII) into Code 128B bar widths.
 * Returns an array of widths: index 0 = first bar (dark), 1 = first space, …
 */
export function encode128B(data: string): number[] {
  const values: number[] = [];

  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code < 32 || code > 126) continue; // skip non-printable
    values.push(code - 32); // Code 128B value = ASCII - 32
  }

  // Checksum: start symbol + sum(value × position)  mod 103
  let checksum = START_B;
  values.forEach((v, i) => { checksum += v * (i + 1); });
  checksum %= 103;

  const bars: number[] = [];

  const pushSymbol = (idx: number) => {
    const pat = SYMBOLS[idx];
    for (let i = 0; i < pat.length; i++) {
      bars.push(parseInt(pat[i], 10));
    }
  };

  pushSymbol(START_B);
  values.forEach(pushSymbol);
  pushSymbol(checksum);
  pushSymbol(STOP_IDX); // stop has 7 elements

  return bars;
}
