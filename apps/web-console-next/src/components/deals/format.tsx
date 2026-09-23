import { Badge } from "@/components/ui/badge";
import { DEAL_STAGE_LABELS, type DealStage } from "@saas/contracts/deal";

/** Integer minor units → "$1,200.00" (or "1200.00 XYZ" for a currency Intl cannot name). */
export function money(cents: number | null | undefined, currency: string): string {
  if (cents === null || cents === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "1,200" or "1200.50" typed by a person → integer cents; null when blank; NaN when unreadable. */
export function toCents(input: string): number | null {
  const t = input.trim().replace(/[$€£,\s]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN;
}

const STAGE_VARIANT: Record<DealStage, "default" | "secondary" | "destructive" | "success" | "warning"> = {
  lead: "secondary",
  pitched: "warning",
  booked: "default",
  delivered: "default",
  paid: "success",
  lost: "destructive",
};

export function StageBadge({ stage }: { stage: DealStage }) {
  return <Badge variant={STAGE_VARIANT[stage]}>{DEAL_STAGE_LABELS[stage]}</Badge>;
}

export const selectClass = "h-9 w-full rounded-md border bg-background px-3 text-sm";
export const labelClass = "block text-sm font-medium mt-3 mb-1";
