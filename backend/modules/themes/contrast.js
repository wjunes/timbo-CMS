/**
 * Contraste de color según WCAG 2.x (luminancia relativa y razón de contraste).
 * https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
 */

/** '#rrggbb' → luminancia relativa (0 negro … 1 blanco). */
export function luminance(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Razón de contraste entre dos colores '#rrggbb' (1 … 21). */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
