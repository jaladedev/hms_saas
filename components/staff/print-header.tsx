import { formatDate } from "@/lib/guest-site/format";

// A line that shows only on paper: which hotel and which days the report covers. On screen the filter form
// already says this, and the form is hidden when printing, so without this line a printed page would not say
// what it is a report of.
export function PrintHeader({ hotel, from, to }: { hotel: string; from: string; to: string }) {
  return (
    <p className="mt-1 hidden text-sm print:block">
      {hotel}, {formatDate(from)} to {formatDate(to)}
    </p>
  );
}
