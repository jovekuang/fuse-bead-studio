export type PaletteColor = { code: string; name: string; hex: string; transparent?: boolean };

// Sampled from the user-supplied "2.6mm fusion bead 264 colors" chart.
// Codes are the chart's labels; hex values approximate the photographed swatches.
const SERIES: Array<{ prefix: string; colors: string[] }> = [
  { prefix: "A", colors: ["#F3E4AC", "#E3E2AE", "#FAE16A", "#F8D815", "#FAC212", "#F2B52C", "#F6790A", "#E0BF2C", "#F29536", "#F48D3E", "#F6CA88", "#F8B18F", "#F8B23A", "#EE4F18", "#F6E457", "#F8ED91", "#F7C852", "#F7B673", "#F37869", "#F3CE5F", "#F6C064", "#F1D890", "#E8C09E", "#F4EDB5", "#E1B455", "#DD9417"] },
  { prefix: "B", colors: ["#DAD827", "#A3C528", "#8DC88B", "#61C54E", "#62A141", "#5BCB9A", "#08AC93", "#098740", "#074638", "#A8DBCA", "#6C833A", "#0C6649", "#CAE086", "#C4E03A", "#0E6134", "#C5DE9E", "#9DB116", "#D8DD72", "#32C19D", "#C1E2C3", "#0F8E94", "#14505A", "#4B513A", "#D9E5B0", "#739590", "#AF9751", "#C5CAB2", "#8EDFB0", "#AACE64", "#D3DDA3", "#A4B98D", "#929445"] },
  { prefix: "C", colors: ["#DAE2CF", "#B7E4E6", "#B8DFE7", "#8AD6EE", "#0BB3C2", "#7AB1D9", "#4679BE", "#0A6EBB", "#3D5CBD", "#26ACC6", "#12A0AA", "#37435D", "#BFD2E4", "#D4E9E7", "#16ADAD", "#3468A1", "#67C2D2", "#415068", "#218CA5", "#2282C1", "#CAD8E0", "#68ACB4", "#AAC1CA", "#74BADD", "#85CBC3", "#209FBA", "#DDE3EB", "#A7B7C6"] },
  { prefix: "D", colors: ["#A4AFEA", "#7E85BE", "#2C4A95", "#293D77", "#B04DB9", "#987BBF", "#663D84", "#DED2F3", "#C7B8DF", "#402B54", "#C2C1E7", "#D79DD0", "#A61691", "#782684", "#443482", "#D8D5E4", "#C4CCED", "#A363B9", "#E2CDE0", "#A554AE", "#8C1C88", "#55579A", "#D1CBE2", "#9197D2", "#4F60B4", "#D4AAC9"] },
  { prefix: "E", colors: ["#FDDEDC", "#FBC5DE", "#F6A0BC", "#EB78A8", "#F066AD", "#F64B78", "#AF1F65", "#F8D7E3", "#E375C1", "#C72C7F", "#F1D7CC", "#F99ECE", "#B00462", "#FCD1BB", "#E5C1C0", "#F0D4CE", "#F3D3DE", "#EFB1C7", "#F9D1E5", "#E9CAD5", "#D09FA0", "#CD7A9E", "#B9889B", "#D6C0D5"] },
  { prefix: "F", colors: ["#FA996A", "#EF5252", "#E53C2E", "#E7242F", "#BB0712", "#A84839", "#791338", "#B41A33", "#E07786", "#89441E", "#733341", "#F1455E", "#D65642", "#F4A799", "#C41B26", "#F6C1B5", "#EDA28F", "#DF927A", "#B8444E", "#D9AC9D", "#E9B0B4", "#F2A997", "#E7805F", "#F59E9E", "#DD4F48"] },
  { prefix: "G", colors: ["#F4D9C4", "#FAC199", "#E3B594", "#D2A17F", "#E79B70", "#EA7244", "#9C5A3D", "#603835", "#E7B276", "#CE8F3C", "#D4BF98", "#C89A67", "#A66C4D", "#906855", "#EDDDC3", "#E8D1BD", "#61504F", "#F3D7B6", "#E19041", "#B3563C", "#D39386"] },
  { prefix: "H", colors: ["#FAFAFA", "#FCFCFC", "#AEAEB0", "#777777", "#444444", "#4B4B4B", "#050505", "#E8D4DB", "#DDDDDD", "#D7C8CD", "#C6C6C4", "#EEE1D6", "#EDDCC1", "#C1C0BF", "#979BA7", "#444444", "#DADAD5", "#F3E8CE", "#E9DECE", "#A9A9A8", "#E3D9C7", "#C1BFBE", "#9C9C8F"] },
  { prefix: "M", colors: ["#D7D8D3", "#7C8977", "#67747D", "#D2BFB6", "#CDC7A2", "#C0AF93", "#B4A09E", "#AC7C70", "#B69A84", "#B0A1AB", "#A4879B", "#654E4F", "#D3967C", "#C16D60", "#787879"] },
  { prefix: "P", colors: ["#E0D5D9", "#979697", "#79A175", "#F16E6E", "#DC873A", "#46A188", "#EEAA82", "#F2D32A", "#C9C7C6", "#B7AFD1", "#E7DBCC", "#CACED6", "#B1C4DC", "#43769F", "#50655B", "#F5CD73", "#E79A0F", "#F6BDAD", "#EEDADF", "#E8B7BC", "#DBA8AA", "#C2867F", "#A25763"] },
  { prefix: "R", colors: ["#CD232D", "#F14996", "#F7A830", "#F9EC1F", "#28B456", "#0B9D85", "#1B658A", "#1C71C3", "#7F4B99", "#F8DE4B", "#F1BCC6", "#B6B0AB", "#484344"] },
  { prefix: "Y", colors: ["#F988C1", "#FAB583", "#CEE0AE", "#92C7DD", "#CA7BC7"] },
];

const STANDARD = SERIES.flatMap(({ prefix, colors }) => colors.map((hex, index): PaletteColor => ({
  code: `${prefix}${index + 1}`,
  name: `${prefix} series ${index + 1}`,
  hex,
})));

export const PALETTE: PaletteColor[] = [
  ...STANDARD,
  { code: "Q2", name: "Q series 2", hex: "#C3DAC3" },
  { code: "Q5", name: "Q series 5", hex: "#3D6C6B" },
  { code: "T1", name: "Glow in the dark", hex: "#F5F5F5" },
].map((color) => color.code === "H1" ? { ...color, name: "Transparent", transparent: true }
  : color.code === "H2" ? { ...color, name: "White" }
  : color.code === "H7" ? { ...color, name: "Black" }
  : color);

export type PaletteCode = string;
export const PALETTE_CODES = new Set(PALETTE.map((color) => color.code));

export function countBeads(cells: Array<string | null>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of cells) if (code) counts[code] = (counts[code] ?? 0) + 1;
  return counts;
}
