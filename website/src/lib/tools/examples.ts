/** Starting texts for the tools page. */

export interface FormatExample {
  readonly name: string;
  readonly text: string;
}

/** A night on call: 30 entries, one per line, the way a log is written. */
const nightLog = (() => {
  const people = ["Ada", "Alan", "Grace", "Edsger"];
  const at = (minute: number) => `Instant("2026-11-12T${String(2 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z")`;
  const lines: string[] = [];
  for (let i = 0, minute = 3; lines.length < 30; i++, minute += 7) {
    const who = people[i % people.length]!;
    const sev = `sev${(i % 3) + 1}`;
    lines.push(`Paged { to: "${who}", at: ${at(minute)}, alert: { name: "disk-${i + 1}", tags: ["night", "${sev}"] } },`);
    if (lines.length < 30)
      lines.push(
        i % 3 === 2
          ? `Escalated { to: "${people[(i + 1) % people.length]}", after: Duration("PT10M"), alert: "disk-${i + 1}" },`
          : `Acknowledged { by: "${who}", at: ${at(minute + 2)}, alert: "disk-${i + 1}" },`,
      );
  }
  return lines.join("\n") + "\n";
})();

export const formatExamples: readonly FormatExample[] = [
  {
    name: "An order on one line",
    text: `// Pick a layout on the right.
Order { id: 1042, customer: { name: "Ada", email: "ada@example.com" }, items: [ { sku: "TEA-01", qty: 2, price: Money(4.50, EUR) }, { sku: "MUG-03", qty: 1, price: Money(12.00, EUR) } ], // the gift note is optional
note: "Happy birthday!" }
`,
  },
  {
    name: "A night of pages (30 entries)",
    text: nightLog,
  },
  {
    name: "Settings with comments",
    text: `// Kitchen and hallway. Comments stay in Pretty, Compact drops them.
{
  kitchen: Light { brightness: 80, // percent
    wakeUp: Time("07:00:00") },
  hallway: Thermostat { target: 21.5, eco: True }, // °C
  frontDoor: Lock { locked: True }
}
`,
  },
];

export const formatDefault = formatExamples[0]!.text;

export interface CompareExample {
  readonly name: string;
  readonly a: string;
  readonly b: string;
}

export const compareExamples: readonly CompareExample[] = [
  {
    name: "Same value, different text",
    a: `Order {
  id: 255,
  total: 19.90,
  tags: ["gift"],
}
`,
    b: `// Written by another tool.
Order({ tags: [ "gift" ], total: 19.90, id: 0xFF })
`,
  },
  {
    name: "19.90 is not 19.9",
    a: `Price { amount: 19.90, currency: EUR }
`,
    b: `Price { amount: 19.9, currency: EUR }
`,
  },
  {
    name: "A missing field is not None",
    a: `{ name: "Ada", backup: None }
`,
    b: `{ name: "Ada" }
`,
  },
  {
    name: "Escapes are spelling",
    a: `{ name: "\\u{41}da", note: "tab:\\there" }
`,
    b: `{ name: "Ada", note: "tab:\\u{9}here" }
`,
  },
  {
    name: "Two logs",
    a: `Paged { to: "Ada", at: Instant("2026-11-12T03:14:00Z") },
Acknowledged { by: "Ada", at: Instant("2026-11-12T03:16:30Z") },
`,
    b: `Paged { to: "Ada", at: Instant("2026-11-12T03:14:00Z") },
Acknowledged { by: "Alan", at: Instant("2026-11-12T03:16:30Z") },
`,
  },
];
