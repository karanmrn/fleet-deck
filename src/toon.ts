// TOON serializer matching the quota-axi house shape:
//   name[N]{field1,field2}:
//     value,value
// Strings containing commas, quotes or whitespace are double-quoted;
// embedded quotes are doubled.

function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  const s = String(value);
  if (/[",\s]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export interface ToonTable {
  name: string;
  fields: string[];
  rows: unknown[][];
}

export function toToon(tables: ToonTable[]): string {
  const out: string[] = [];
  for (const t of tables) {
    if (t.fields.length > 0) {
      out.push(`${t.name}[${t.rows.length}]{${t.fields.join(",")}}:`);
    } else {
      out.push(`${t.name}[${t.rows.length}]:`);
    }
    for (const row of t.rows) {
      out.push("  " + row.map(esc).join(","));
    }
  }
  return out.join("\n");
}
