import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface Tab {
  /** Also the name of the Astro slot holding this tab's pre-highlighted code. */
  value: string;
  label: string;
  caption?: string;
}

type Props = { tabs: Tab[] } & Record<string, ReactNode | Tab[]>;

const trigger = "tab-brush px-1 pb-1.5 text-[0.98rem] font-medium text-ink-3 transition-colors hover:text-ink data-active:text-ink";
// All panels share one grid cell, so the area is as tall as the tallest one and
// switching tabs never changes the layout (or the washes painted around it).
const panel =
  "col-start-1 row-start-1 min-w-0 text-base data-[state=inactive]:invisible data-[state=inactive]:pointer-events-none";

export default function CodeTabs({ tabs, ...slots }: Props) {
  return (
    <Tabs defaultValue={tabs[0].value} className="min-w-0 gap-4">
      <TabsList variant="line" className="h-auto gap-5 p-0">
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value} className={trigger}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <div className="grid grid-cols-[minmax(0,1fr)]">
        {tabs.map((t) => (
          <TabsContent key={t.value} value={t.value} forceMount className={panel}>
            {slots[t.value] as ReactNode}
            {t.caption && <p className="mt-4 text-[0.92rem] text-ink-3">{t.caption}</p>}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}
