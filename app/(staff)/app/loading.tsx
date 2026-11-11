import { PageSkeleton } from "@/components/ui/skeleton";

// Shown inside the staff layout (the sidebar stays put) while the next page's data loads.
export default function Loading() {
  return <PageSkeleton label="Loading this page" />;
}
